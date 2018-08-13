package main

import (
	"fmt"
	"io/ioutil"
	"log"
	"time"

	"github.com/gomodule/redigo/redis"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"github.com/tile38/msgkit"
)

const dist = 100
const group = "people"

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

	// Create the websocket server and bind all message handlers
	srv = msgkit.New("/ws")
	srv.Static("/", "web")
	srv.Handle("ID", id)           // Handle messages for the users ID
	srv.Handle("Places", places)   // Handle messages for geofences and objects
	srv.Handle("Feature", feature) // Handle messages about feature updates
	srv.Handle("Message", message) // Handle messages about chat messages

	// Create an object and geofence for the Convention Center
	cc := readFence("convention-center")
	redisDo("SET", "places", "convention-center", "OBJECT", cc)
	go watch(gjson.Get(cc, "properties").String(), "WITHIN", group, "FENCE",
		"DETECT", "enter,exit", "OBJECT", cc)

	// Create an object and geofence for the Hyatt Regency
	h := readFence("hyatt")
	redisDo("SET", "places", "hyatt", "OBJECT", h)
	go watch(gjson.Get(h, "properties").String(), "WITHIN", group, "FENCE",
		"DETECT", "enter,exit", "OBJECT", h)

	// Create a geofence for all movements all over the world
	go watch("", "INTERSECTS", group, "FENCE", "BOUNDS", -90, -180, 90, 180)

	// Create a roaming geofence for all points
	go watch("", "NEARBY", group, "FENCE", "ROAM", group, "*", dist)

	// Start listening for websocket messages
	log.Println(srv.Listen(":8000"))
}

// watch continuously subscribes and listens for geofence notifications
func watch(prop string, cmd string, args ...interface{}) {
	for {
		subscribe(prop, cmd, args...)
	}
}

// subscribe will listen for geofence notifications, piping all notifications
// out to all connected websocket clients
func subscribe(prop string, cmd string, args ...interface{}) {
	conn := pool.Get()
	defer conn.Close()

	resp, err := redis.String(conn.Do(cmd, args...))
	if err != nil || resp != "OK" {
		log.Printf("watch: %v", err)
		return
	}

	for {
		msg, err := redis.String(conn.Receive())
		if err != nil {
			log.Printf("watch: %v", err)
			return
		}

		for _, id := range srv.ConnIDs() {
			if prop != "" {
				msg, _ = sjson.SetRaw(msg, "properties", prop)
			}
			if c, ok := srv.Conns.Get(id); ok {
				c.Send(msg)
			}
		}
	}
}

// id is a basic websocket message handler that returns the connections ID back
// to the messager
func id(c *msgkit.Context) error {
	return c.Conn.Send(fmt.Sprintf(`{"type":"ID","id":"%s"}`, c.ConnID))
}

// places is a websocket message handler that retrieves all objects/polygons
// in the Tile38 database and returns writes them to the messager
func places(c *msgkit.Context) error {
	// SCAN all places in Tile38
	places, err := redis.Values(redisDo("SCAN", "places"))
	if err != nil {
		log.Printf("places: %v\n", err)
		return nil
	}

	if len(places) > 1 {
		ps, _ := redis.Values(places[1], nil)
		for _, p := range ps {
			kv, _ := redis.ByteSlices(p, nil)
			c.Conn.Send(string(kv[1]))
		}
	}
	return nil
}

// feature is a websocket message handler that creates/updates a points location
// in Tile38, keyed by the ID in the message
func feature(c *msgkit.Context) error {
	redisDo("SET", group, c.ConnID, "EX", 5, "OBJECT", c.Message)
	return nil
}

// message is a websocket message handler that queries Tile38 for other users
// located in the messagers geofence and broadcasts a chat message to them
func message(c *msgkit.Context) error {
	feature := gjson.GetBytes(c.Message, "feature").String()

	// Get the connected clients from Tile38
	cc, err := connectedClients(
		gjson.Get(feature, "geometry.coordinates.0").Float(),
		gjson.Get(feature, "geometry.coordinates.1").Float())
	if err != nil {
		log.Printf("connected-clients: %v\n", err)
		return nil
	}

	for cid, places := range cc {
		if ws, ok := srv.Conns.Get(cid); ok {
			newMsg, _ := sjson.SetBytes(c.Message, "feature.properties.via",
				places)
			ws.Send(string(newMsg))
		}
	}
	return nil
}

// connectedClients queries Tile38 for any users located in the same geofence
// as the messager located at the x and y coordinates passed
func connectedClients(x, y float64) (map[string][]string, error) {
	// map of person ID to a slice of connected geo-fences
	idMap := make(map[string][]string)

	// Get all intersecting places for the point
	placeRes, err := redis.Values(redisDo("INTERSECTS", "places", "IDS",
		"BOUNDS", y, x, y, x))
	if err != nil {
		return nil, err
	}
	if len(placeRes) > 1 {
		placeIDs, _ := redis.Strings(placeRes[1], nil)
		for _, placeID := range placeIDs {
			// Get all intersecting points in those places
			peopleRes, err := redis.Values(redisDo("INTERSECTS", "people",
				"IDS", "GET", "places", placeID))
			if err != nil {
				return nil, err
			}

			peopleIDs, _ := redis.Strings(peopleRes[1], nil)
			for _, v := range peopleIDs {
				idMap[v] = append(idMap[v], placeID)
			}
		}
	}

	// Get all nearby people
	nearbyRes, err := redis.Values(redisDo("NEARBY", group, "IDS", "POINT", y,
		x, dist))
	if err != nil {
		return nil, err
	}
	peopleIDs, _ := redis.Strings(nearbyRes[1], nil)
	for _, v := range peopleIDs {
		idMap[v] = append(idMap[v], "roaming")
	}
	return idMap, nil
}

// redisDo executes a redis command on a new connection and returns the response
func redisDo(cmd string, args ...interface{}) (interface{}, error) {
	conn := pool.Get()
	defer conn.Close()
	return conn.Do(cmd, args...)
}

// readFence reads the geofence Feature data from the fences directory and
// returns the contents of the file
func readFence(filename string) string {
	gj, err := ioutil.ReadFile("fences/" + filename + ".geo.json")
	if err != nil {
		log.Fatal(err)
	}
	return string(gj)
}
