package main

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/gomodule/redigo/redis"
	"github.com/tidwall/gjson"
	"github.com/tile38/msgkit"
	"github.com/tile38/msgkit/safews"
)

const dist = 250

var pool *redis.Pool   // The Tile38 connection pool
var srv *msgkit.Server // The websocket server

func main() {
	// Create a new pool of connections to Tile38
	pool = &redis.Pool{
		MaxIdle:     16,
		IdleTimeout: 240 * time.Second,
		Dial: func() (redis.Conn, error) {
			return redis.Dial("tcp", ":9851")
		},
	}

	// Initialize a new msgkit server and bind all handlers
	srv = msgkit.New("/ws").
		Static("/", "web").
		OnOpen(onOpen).
		OnClose(onClose).
		Handle("Feature", feature).
		Handle("Viewport", viewport).
		Handle("Message", message)

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
	log.Println(srv.Listen(":8000"))
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
func onOpen(connID string, conn *safews.Conn) {
	conn.Send(fmt.Sprintf(`{"type":"ID","id":"%s"}`, connID))
}

// onCLose deletes the clients point in the people collection on a disconnect
func onClose(connID string, conn *safews.Conn) {
	log.Println("DELETING PERSON ", connID)
	redisDo("DEL", "people", connID)
	log.Println("DELETING VIEWPORT OBJECT ", connID)
	redisDo("DEL", "viewport", connID)
	log.Println("DELETING VIEWPORT GEOFENCE ", connID)
	redisDo("DELCHAN", "viewport:"+connID)
}

// feature is a websocket message handler that creates/updates a persons
// position in Tile38
func feature(c *msgkit.Context) {
	log.Println("CREATING PERSON ", c.ConnID)
	redisDo("SET", "people", c.ConnID, "EX", 30, "OBJECT", c.Message)
}

// viewport is a websocket message handler that queries Tile38 for all people
// currently in a clients viewport
func viewport(c *msgkit.Context) {
	swLat := gjson.GetBytes(c.Message, "data._sw.lat").Float()
	swLng := gjson.GetBytes(c.Message, "data._sw.lng").Float()
	neLat := gjson.GetBytes(c.Message, "data._ne.lat").Float()
	neLng := gjson.GetBytes(c.Message, "data._ne.lng").Float()

	log.Println("CREATING VIEWPORT OBJECT ", c.ConnID)

	// Create the viewport bounds and geofence in Tile38
	redisDo("SET", "viewport", c.ConnID, "EX", 30, "BOUNDS", swLat, swLng,
		neLat, neLng)

	log.Println("CREATING VIEWPORT GEOFENCE ", c.ConnID)

	redisDo("SETCHAN", "viewport:"+c.ConnID, "WITHIN", "people", "FENCE",
		"DETECT", "exit", "BOUNDS", swLat, swLng, neLat, neLng)

	// Query for all people in the viewport bounds
	people, _ := redis.Values(redisDo("INTERSECTS", "people", "GET", "viewport",
		c.ConnID))

	// Send all people in the viewport to the messager
	if len(people) > 1 {
		ps, _ := redis.Values(people[1], nil)
		for _, p := range ps {
			kv, _ := redis.ByteSlices(p, nil)
			c.Conn.Send(string(kv[1]))
		}
	}
}

// message is a websocket message handler that queries Tile38 for other users
// located in the messagers geofence and broadcasts a chat message to them
func message(c *msgkit.Context) {
	feature := gjson.GetBytes(c.Message, "feature").String()

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
		sendAll(string(c.Message), nearby...)
	}
}

// sendAll sends the passed websocket message to all connection IDs passed
func sendAll(msg string, connIDs ...string) {
	if len(connIDs) == 0 {
		connIDs = srv.Conns.IDs()
	}
	for _, connID := range connIDs {
		if ws, ok := srv.Conns.Get(connID); ok {
			ws.Send(msg)
		}
	}
}

// redisDo executes a redis command on a new connection and returns the response
func redisDo(cmd string, args ...interface{}) (interface{}, error) {
	conn := pool.Get()
	defer conn.Close()
	return conn.Do(cmd, args...)
}
