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
	"github.com/tile38/msgkit/safews"
)

const dist = 100
const group = "people"

var srv *msgkit.Server // The websocket server
var pool *redis.Pool   // The Tile38 connection pool

func main() {
	// Create a new pool of connections to Tile38
	pool = &redis.Pool{
		MaxIdle:     16,
		IdleTimeout: 240 * time.Second,
		Dial: func() (redis.Conn, error) {
			return redis.Dial("tcp", ":9851")
		},
	}

	srv = msgkit.New("/ws")        // Initialize a new msgkit server
	srv.Static("/", "web")         // Bind the static web server
	srv.OnOpen(onOpen)             // Handle Connection opened events
	srv.OnClose(onClose)           // Handle Connection closed events
	srv.Handle("Feature", feature) // Handle messages about feature updates
	srv.Handle("Message", message) // Handle messages about chat messages

	// Create a geofence for all movements around the world
	go watch("", "INTERSECTS", group, "FENCE", "BOUNDS", -90, -180, 90, 180)

	// Create an object and geofence for the Convention Center
	createStaticFence("convention-center")

	// Create an object and geofence for the Hyatt Regency
	createStaticFence("hyatt-regency")

	// Create a roaming geofence for every person
	go watch("", "NEARBY", group, "FENCE", "ROAM", group, "*", dist)

	// Start listening for websocket messages
	log.Println(srv.Listen(":8000"))
}

// createStaticFence reads a local geojson file, creates a place object so it is
// viewable on a map, and watches for enters or exits in the area
func createStaticFence(name string) {
	gj, err := ioutil.ReadFile("fences/" + name + ".geo.json")
	if err != nil {
		log.Fatal(err)
	}

	// Create a place object with the geojson
	redisDo("SET", "places", name, "OBJECT", string(gj))

	// Watch a static geofence in the geojsons area
	go watch(gjson.GetBytes(gj, "properties").String(), "WITHIN", group,
		"FENCE", "DETECT", "enter,exit", "OBJECT", string(gj))
}

// watch continuously subscribes and listens for geofence notifications
func watch(prop string, cmd string, args ...interface{}) {
	for {
		subscribe(prop, cmd, args...)
	}
}

// subscribe listens for all geofence notifications, piping them out to all
// connected websocket clients
func subscribe(prop string, cmd string, args ...interface{}) {
	conn := pool.Get()
	defer conn.Close()

	// Create subscription with Tile38 Fence command
	resp, err := redis.String(conn.Do(cmd, args...))
	if err != nil || resp != "OK" {
		log.Printf("watch: %v", err)
		return
	}

	for {
		// Read a message from the connection
		msg, err := redis.String(conn.Receive())
		if err != nil {
			log.Printf("watch: %v", err)
			return
		}

		// Add any custom properties to the payload
		if prop != "" {
			msg, _ = sjson.SetRaw(msg, "properties", prop)
		}

		// Forward the message from Tile38 to all connected websocket clients
		for _, id := range srv.Conns.IDs() {
			if c, ok := srv.Conns.Get(id); ok {
				c.Send(msg)
			}
		}
	}
}

// onOpen is an EventHandler that sends the clients ID and all places to the
// client as soon as they connect
func onOpen(connID string, conn *safews.Conn) {
	// Send the client their ID
	conn.Send(fmt.Sprintf(`{"type":"ID","id":"%s"}`, connID))

	// SCAN all places in Tile38
	places, err := redis.Values(redisDo("SCAN", "places"))
	if err != nil {
		log.Printf("places: %v\n", err)
		return
	}

	// Parse the slice of places and send it to the messager
	if len(places) > 1 {
		ps, _ := redis.Values(places[1], nil)
		for _, p := range ps {
			kv, _ := redis.ByteSlices(p, nil)
			conn.Send(string(kv[1]))
		}
	}
}

// onCLose deletes the client from Tile38 when the websocket connection is
// closed
func onClose(connID string, conn *safews.Conn) {
	redisDo("DEL", group, connID)
}

// feature is a websocket message handler that creates/updates a points location
// in Tile38, keyed by the ID in the message
func feature(c *msgkit.Context) {
	redisDo("SET", group, c.ConnID, "EX", 5, "OBJECT", c.Message)
}

// message is a websocket message handler that queries Tile38 for other users
// located in the messagers geofence and broadcasts a chat message to them
func message(c *msgkit.Context) {
	feature := gjson.GetBytes(c.Message, "feature").String()

	// Get the connected clients from Tile38
	cc, err := connectedClients(
		gjson.Get(feature, "geometry.coordinates.0").Float(),
		gjson.Get(feature, "geometry.coordinates.1").Float())
	if err != nil {
		log.Printf("connected-clients: %v\n", err)
		return
	}

	for cid, places := range cc {
		if ws, ok := srv.Conns.Get(cid); ok {
			newMsg, _ := sjson.SetBytes(c.Message, "feature.properties.via",
				places)
			ws.Send(string(newMsg))
		}
	}
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
