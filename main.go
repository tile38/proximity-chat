package main

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gomodule/redigo/redis"
	"github.com/tidwall/gjson"
	"github.com/tile38/msgkit"
)

const dist = 250

var pool *redis.Pool // The Tile38 connection pool
//var srv *msgkit.Server // The websocket server
var h msgkit.Handler

func main() {
	// Create a new pool of connections to Tile38
	pool = &redis.Pool{
		MaxIdle:     16,
		IdleTimeout: 240 * time.Second,
		Dial: func() (redis.Conn, error) {
			return redis.Dial("tcp", ":9851")
		},
	}

	// Initialize a new msgkit server and bind all handlers to "/ws"
	h.OnOpen = onOpen
	h.OnClose = onClose
	h.Handle("Feature", feature)
	h.Handle("Viewport", viewport)
	h.Handle("Message", message)
	http.Handle("/ws", &h)
	http.Handle("/", http.FileServer(http.Dir("web")))

	// Create a world and roaming geofence
	redisDo("SETCHAN", "worldchan", "INTERSECTS", "people", "FENCE", "BOUNDS",
		-90, -180, 90, 180)
	redisDo("SETCHAN", "roamchan", "NEARBY", "people", "FENCE", "ROAM",
		"people", "*", dist)

	// Subscribe to viewport, world, and roaming geofence notifications
	go func() {
		for {
			psubscribe("viewport:*", "worldchan", "roamchan")
		}
	}()

	// Start listening for websocket connections and messages
	srv := &http.Server{Addr: ":8000"}
	log.Fatal(srv.ListenAndServe())
}

// psubscribe listens on all passed channels for notifications, piping them out
// to all connected websocket clients who can see the changes
func psubscribe(channels ...interface{}) {
	psc := redis.PubSubConn{Conn: pool.Get()}
	defer psc.Close()
	psc.PSubscribe(channels...)
	for {
		switch v := psc.Receive().(type) {
		case redis.Message:
			msg := string(v.Data)

			command := gjson.Get(msg, "command").String()
			if command == "set" || command == "del" {
				// Send any viewport notifications to only listening viewport
				hook := gjson.Get(msg, "hook").String()
				if strings.Contains(hook, "viewport:") {
					sendAll(msg, strings.Split(hook, ":")[1])
					continue
				}

				// Send any roaming to all listening for roaming
				if strings.Contains(hook, "roamchan") {
					sendAll(msg)
					continue
				}

				// Send all other update notifications to those who can see it
				res, _ := redis.Values(redisDo("INTERSECTS", "viewport", "IDS",
					"GET", "people", gjson.Get(msg, "id").String()))
				if len(res) > 1 {
					ids, _ := redis.Strings(res[1], nil)
					sendAll(msg, ids...)
				}
				continue
			} else {
				sendAll(msg)
			}
		case error:
			log.Printf("psubscribe: %v\n", v)
			continue
		}
	}
}

// onOpen is an EventHandler that sends the client their connection identifier
func onOpen(id string) {
	h.Send(id, fmt.Sprintf(`{"type":"ID","id":"%s"}`, id))
}

// onCLose deletes the clients point in the people collection on a disconnect
func onClose(id string) {
	redisDo("DEL", "people", id)
	redisDo("DEL", "viewport", id)
	redisDo("DELCHAN", "viewport:"+id)
}

// feature is a websocket message handler that creates/updates a persons
// position in Tile38
func feature(id, msg string) {
	redisDo("SET", "people", id, "EX", 30, "OBJECT", msg)
}

// viewport is a websocket message handler that queries Tile38 for all people
// currently in a clients viewport
func viewport(id, msg string) {
	swLat := gjson.Get(msg, "data._sw.lat").Float()
	swLng := gjson.Get(msg, "data._sw.lng").Float()
	neLat := gjson.Get(msg, "data._ne.lat").Float()
	neLng := gjson.Get(msg, "data._ne.lng").Float()

	// Create the viewport bounds and geofence in Tile38
	redisDo("SET", "viewport", id, "EX", 30, "BOUNDS", swLat, swLng,
		neLat, neLng)

	redisDo("SETCHAN", "viewport:"+id, "WITHIN", "people", "FENCE",
		"DETECT", "exit", "BOUNDS", swLat, swLng, neLat, neLng)

	// Query for all people in the viewport bounds
	people, _ := redis.Values(redisDo("INTERSECTS", "people", "GET", "viewport",
		id))

	// Send all people in the viewport to the messager
	if len(people) > 1 {
		ps, _ := redis.Values(people[1], nil)
		for _, p := range ps {
			kv, _ := redis.ByteSlices(p, nil)
			h.Send(id, string(kv[1]))
		}
	}
}

// message is a websocket message handler that queries Tile38 for other users
// located in the messagers geofence and broadcasts a chat message to them
func message(id, msg string) {
	feature := gjson.Get(msg, "feature").String()

	// Query all nearby people from Tile38
	nearbyRes, err := redis.Values(redisDo("NEARBY", "people", "IDS", "POINT",
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
		h.RangeIDs(func(id string) bool {
			connIDs = append(connIDs, id)
			return true
		})
	}
	for _, connID := range connIDs {
		h.Send(connID, msg)
	}
}

// redisDo executes a redis command on a new connection and returns the response
func redisDo(cmd string, args ...interface{}) (interface{}, error) {
	conn := pool.Get()
	defer conn.Close()
	return conn.Do(cmd, args...)
}
