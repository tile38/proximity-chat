package main

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gomodule/redigo/redis"
	"github.com/paulbellamy/ratecounter"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"github.com/tile38/msgkit"
)

const dist = 1000

var (
	pool        *redis.Pool       // The Tile38 connection pool
	h           msgkit.Handler    // The websocket server handler
	idmu        sync.Mutex        // guard maps
	connClientM map[string]string // clientID -> connID map
	clientConnM map[string]string // connID -> clientID map
)

func main() {
	// Create a new pool of connections to Tile38
	pool = &redis.Pool{
		MaxIdle:     16,
		IdleTimeout: 240 * time.Second,
		Dial: func() (redis.Conn, error) {
			return redis.Dial("tcp", ":9851")
		}, TestOnBorrow: func(conn redis.Conn, _ time.Time) error {
			s, err := redis.String(conn.Do("PING"))
			if err != nil {
				return err
			}
			if s != "PONG" {
				return errors.New("expected PONG")
			}
			return nil
		},
	}

	connClientM = make(map[string]string)
	clientConnM = make(map[string]string)

	// Initialize a new msgkit server
	h.OnOpen = onOpen
	h.OnClose = onClose
	h.Handle("Feature", feature)
	h.Handle("Viewport", viewport)
	h.Handle("Message", message)

	// Bind websockets to "/ws" and static site to "/"
	http.Handle("/ws", &h)
	http.Handle("/", http.FileServer(http.Dir("web")))

	// Subscribe to geofence channels
	go geofenceSubscribe()

	// Start listening for websocket connections and messages
	srv := &http.Server{Addr: ":8000"}
	log.Printf("Listening at %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}

var msgCount int64
var msgSize int64

var mu sync.Mutex
var counter = ratecounter.NewRateCounter(time.Second)

func send(id, msg string) {
	counter.Incr(1)

	n := atomic.AddInt64(&msgCount, 1)
	z := atomic.AddInt64(&msgSize, int64(len(msg)))
	h.Send(id, msg)

	rate := counter.Rate()

	mu.Lock()
	fmt.Printf("\rmsg: %d (%d/sec), bytes: %d MB", n, rate, z/1024/1024)
	mu.Unlock()

}

// geofenceSubscribe listens on geofence channels notifications, piping them out
// to all connected websocket clients who can see the changes
func geofenceSubscribe() {
	fn := func() error {
		var err error
		// Ensure that the geofence channels exist
		_, err = tile38Do("SETCHAN", "worldchan", "INTERSECTS", "people", "BOUNDS", -90, -180, 90, 180)
		if err != nil {
			return err
		}
		_, err = tile38Do("SETCHAN", "roamchan", "NEARBY", "people", "ROAM", "people", "*", dist)
		if err != nil {
			return err
		}

		psc := redis.PubSubConn{Conn: pool.Get()}
		defer psc.Close()

		err = psc.PSubscribe("viewport:*", "worldchan", "roamchan")
		if err != nil {
			return err
		}

		log.Printf("psubscribe: opened")
		defer log.Printf("psubscribe: closed")
		for {
			switch v := psc.Receive().(type) {
			case redis.Message:
				switch v.Pattern {
				case "viewport:*":
				case "worldchan":
					obj := gjson.GetBytes(v.Data, "object")
					if !obj.Exists() {
						// feature not available
						continue
					}
					clientID := obj.Get("id").String()
					idmu.Lock()
					connID := clientConnM[clientID]
					idmu.Unlock()
					msg := `{"type":"Update","feature":` + secureFeature(obj.Raw) + `}`
					h.Range(func(id string) bool {
						if id != connID {
							send(id, msg)
						}
						return true
					})
				case "roamchan":
					clientID := gjson.GetBytes(v.Data, "object.id").String()
					idmu.Lock()
					connID := clientConnM[clientID]
					idmu.Unlock()
					if connID == "" {
						// connection not found
						continue
					}
					nearby := gjson.GetBytes(v.Data, "nearby")
					if nearby.Exists() {
						// an object is nearby, notify the target connection
						send(connID, `{"type":"Nearby",`+
							`"feature":`+secureFeature(nearby.Get("object").Raw)+`}`)
						continue
					}
					faraway := gjson.GetBytes(v.Data, "faraway")
					if faraway.Exists() {
						// an object is faraway, notify the target connection
						send(connID, `{"type":"Faraway",`+
							`"feature":`+secureFeature(faraway.Get("object").Raw)+`}`)
						continue
					}
				}

				// msg := string(v.Data)
				// switch {
				// case gjson.Get(msg, "hook").String():

				// }
				// command := gjson.Get(msg, "command").String()
				// if command == "set" || command == "del" {
				// 	// Send any viewport notifications to only listening viewport
				// 	hook := gjson.Get(msg, "hook").String()
				// 	if strings.Contains(hook, "viewport:") {
				// 		sendAll(msg, strings.Split(hook, ":")[1])
				// 		continue
				// 	}
				// 	// Send any roaming to all listening for roaming
				// 	if strings.Contains(hook, "roamchan") {
				// 		sendAll(msg)
				// 		continue
				// 	}
				// 	// // Send all other update notifications to those who can see it
				// 	// res, err := redis.Values(tile38Do(
				// 	// 	"INTERSECTS", "viewport", "IDS", "GET", "people", gjson.Get(msg, "id").String(),
				// 	// ))
				// 	// if err != nil {
				// 	// 	return err
				// 	// }
				// 	// if len(res) > 1 {
				// 	// 	ids, _ := redis.Strings(res[1], nil)

				// 	// 	sendAll(msg, ids...)
				// 	// }
				// } else {
				// 	sendAll(msg)
				// }
			case error:
				return v
			}
		}
	}
	for {
		err := fn()
		log.Printf("psubscribe: %v", err)
		time.Sleep(time.Second)
	}
}

var connected int32

func onOpen(connID string) {
	println("open", connID, atomic.AddInt32(&connected, 1))

}

// onClose deletes the clients point in the people collection on a disconnect
func onClose(connID string) {
	println("close", connID, atomic.AddInt32(&connected, -1))
	idmu.Lock()
	clientID, ok := connClientM[connID]
	if ok {
		delete(connClientM, connID)
		delete(clientConnM, clientID)
	}
	idmu.Unlock()
	if ok {
		tile38Do("DEL", "people", clientID)
		tile38Do("DEL", "viewport", clientID)
		tile38Do("DELCHAN", "viewport:"+clientID)
	}
}

// feature is a websocket message handler that creates/updates a persons
// position in Tile38
func feature(connID, msg string) {
	clientID := gjson.Get(msg, "id").String()
	if len(clientID) != 24 {
		return
	}

	// Track all connID <-> clientID
	idmu.Lock()
	clientConnM[clientID] = connID
	connClientM[connID] = clientID
	idmu.Unlock()

	// fmt.Printf("A: connID: %v, clientID: %v\n", connID, clientID)

	// Update the position in the database
	tile38Do("SET", "people", clientID, "EX", 10, "OBJECT", msg)
}

// secureFeature re-hashes the clientID to avoid spoofing
func secureFeature(feature string) string {
	feature, _ = sjson.Set(feature, "id",
		secureClientID(gjson.Get(feature, "id").String()))
	return feature
}

// secureClientID re-hashes the clientID to avoid spoofing
func secureClientID(clientID string) string {
	b := md5.Sum([]byte(clientID))
	return hex.EncodeToString(b[:12])
}

// viewport is a websocket message handler that queries Tile38 for all people
// currently in a clients viewport
func viewport(id, msg string) {
	swLat := gjson.Get(msg, "data._sw.lat").Float()
	swLng := gjson.Get(msg, "data._sw.lng").Float()
	neLat := gjson.Get(msg, "data._ne.lat").Float()
	neLng := gjson.Get(msg, "data._ne.lng").Float()

	// Create the viewport bounds and geofence in Tile38
	tile38Do("SET", "viewport", id, "EX", 30, "BOUNDS", swLat, swLng,
		neLat, neLng)

	tile38Do("SETCHAN", "viewport:"+id, "WITHIN", "people", "FENCE",
		"DETECT", "exit", "BOUNDS", swLat, swLng, neLat, neLng)

	// Query for all people in the viewport bounds
	people, _ := redis.Values(tile38Do("INTERSECTS", "people", "GET", "viewport",
		id))

	// Send all people in the viewport to the messager
	if len(people) > 1 {
		ps, _ := redis.Values(people[1], nil)
		for _, p := range ps {
			kv, _ := redis.ByteSlices(p, nil)
			send(id, string(kv[1]))
		}
	}
}

// message is a websocket message handler that queries Tile38 for other users
// located in the messagers geofence and broadcasts a chat message to them
func message(id, msg string) {
	feature := gjson.Get(msg, "feature").String()

	// Query all nearby people from Tile38
	nearbyRes, err := redis.Values(tile38Do("NEARBY", "people", "IDS", "POINT",
		gjson.Get(feature, "geometry.coordinates.1").Float(),
		gjson.Get(feature, "geometry.coordinates.0").Float(), dist))
	if err != nil {
		log.Printf("message: %v\n", err)
		return
	}

	if len(nearbyRes) > 1 {
		// Send the message to all nearby people
		nearby, _ := redis.Strings(nearbyRes[1], nil)
		sendAll(string(msg), nearby...)
	}
}

// sendAll sends the passed websocket message to all connection IDs passed
func sendAll(msg string, connIDs ...string) {
	if len(connIDs) == 0 {
		h.Range(func(id string) bool {
			connIDs = append(connIDs, id)
			return true
		})
	}
	for _, connID := range connIDs {
		send(connID, msg)
	}
}

// tile38Do executes a redis command on a new connection and returns the response
func tile38Do(cmd string, args ...interface{}) (interface{}, error) {
	conn := pool.Get()
	defer conn.Close()
	return conn.Do(cmd, args...)
}
