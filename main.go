package main

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gomodule/redigo/redis"
	"github.com/paulbellamy/ratecounter"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"github.com/tile38/msgkit"
)

const dist = 1000 //1000

var (
	pool        *redis.Pool       // The Tile38 connection pool
	h           msgkit.Handler    // The websocket server handler
	idmu        sync.Mutex        // guard maps
	connClientM map[string]string // clientID -> connID map
	clientConnM map[string]string // connID -> clientID map
)

func main() {
	var addr string
	flag.StringVar(&addr, "tile38", ":9851", "Tile38 Address")
	flag.BoolVar(&metrics, "metrics", false, "Show message metrics")
	flag.Parse()

	// Create a new pool of connections to Tile38
	pool = &redis.Pool{
		MaxIdle:     16,
		IdleTimeout: 240 * time.Second,
		Dial: func() (redis.Conn, error) {
			return redis.Dial("tcp", addr)
		}, TestOnBorrow: func(conn redis.Conn, _ time.Time) error {
			if resp, _ := redis.String(conn.Do("PING")); resp != "PONG" {
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

var metrics bool
var msgMu sync.Mutex
var msgCount int
var msgSize uint64
var msgCounter = ratecounter.NewRateCounter(time.Second)

func send(id, msg string) {
	h.Send(id, msg)
	if metrics {
		msgMu.Lock()
		msgCounter.Incr(1)
		msgCount++
		msgSize += uint64(len(msg))
		rate := msgCounter.Rate()
		fmt.Printf("\rmsg: %d (%d/sec), bytes: %d MB", msgCount, rate, msgSize/1024/1024)
		msgMu.Unlock()
	}
}

// geofenceSubscribe listens on geofence channels notifications, piping them out
// to all connected websocket clients who can see the changes
func geofenceSubscribe() {
	fn := func() error {
		// Ensure that the roaming geofence channel exists
		_, err := tile38Do(
			"SETCHAN", "roamchan",
			"NEARBY", "people", "ROAM", "people", "*", dist,
		)
		if err != nil {
			return err
		}

		psc := redis.PubSubConn{Conn: pool.Get()}
		defer psc.Close()

		// Subscribe to the channel
		err = psc.Subscribe("roamchan")
		if err != nil {
			return err
		}

		log.Printf("subscribe: opened")
		defer log.Printf("subscribe: closed")

		for {
			switch v := psc.Receive().(type) {
			case redis.Message:
				switch v.Channel {
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
	//	println("open", connID, atomic.AddInt32(&connected, 1))

}

// onClose deletes the clients point in the people collection on a disconnect
func onClose(connID string) {
	// println("close", connID, atomic.AddInt32(&connected, -1))
	idmu.Lock()
	clientID, ok := connClientM[connID]
	if ok {
		delete(connClientM, connID)
		delete(clientConnM, clientID)
	}
	idmu.Unlock()
	if ok {
		tile38Do("DEL", "people", clientID)
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

	swLat := gjson.Get(msg, "bounds._sw.lat").Float()
	swLng := gjson.Get(msg, "bounds._sw.lng").Float()
	neLat := gjson.Get(msg, "bounds._ne.lat").Float()
	neLng := gjson.Get(msg, "bounds._ne.lng").Float()

	var cursor int64
	for {
		// Query for all people in the viewport bounds
		people, _ := redis.Values(tile38Do(
			"INTERSECTS", "people",
			"CURSOR", cursor,
			"BOUNDS", swLat, swLng, neLat, neLng,
		))
		if len(people) < 2 {
			return
		}
		cursor, _ = redis.Int64(people[0], nil)

		idmu.Lock()
		clientID := connClientM[id]
		idmu.Unlock()

		// Send all people in the viewport to the messager
		var features []byte
		var idx int
		features = append(features, `{"type":"Update","features":[`...)
		ps, _ := redis.Values(people[1], nil)
		for _, p := range ps {
			strs, _ := redis.Strings(p, nil)
			if len(strs) > 1 && strs[0] != clientID {
				feature := secureFeature(strs[1])
				if idx > 0 {
					features = append(features, ',')
				}
				features = append(features, feature...)
				idx++
			}
		}
		features = append(features, `]}`...)
		send(id, string(features))

		if cursor == 0 {
			break
		}
	}
}

// message is a websocket message handler that queries Tile38 for other users
// located in the messagers geofence and broadcasts a chat message to them
func message(id, msg string) {
	// create a new message
	nmsg := `{"type":"Message"}`
	nmsg, _ = sjson.SetRaw(nmsg, "feature", secureFeature(gjson.Get(msg, "feature").String()))
	nmsg, _ = sjson.Set(nmsg, "text", gjson.Get(msg, "text").String())

	// Query all nearby people from Tile38
	lat := gjson.Get(msg, "feature.geometry.coordinates.1").Float()
	lng := gjson.Get(msg, "feature.geometry.coordinates.0").Float()
	var cursor int64
	for {
		people, _ := redis.Values(
			tile38Do(
				"NEARBY", "people", "CURSOR", 0, "IDS", "POINT", lat, lng, dist,
			),
		)
		if len(people) < 2 {
			return
		}
		cursor, _ = redis.Int64(people[0], nil)
		ps, _ := redis.Values(people[1], nil)
		for _, p := range ps {
			clientID, _ := redis.String(p, nil)
			idmu.Lock()
			connID := clientConnM[clientID]
			idmu.Unlock()
			send(connID, nmsg)
		}
		if cursor == 0 {
			break
		}
	}
}

// tile38Do executes a redis command on a new connection and returns the response
func tile38Do(cmd string, args ...interface{}) (interface{}, error) {
	conn := pool.Get()
	defer conn.Close()
	return conn.Do(cmd, args...)
}
