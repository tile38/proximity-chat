package main

import (
	"crypto/md5"
	"fmt"
	"io/ioutil"
	"log"
	"strings"
	"time"

	"github.com/gomodule/redigo/redis"
	"github.com/gorilla/websocket"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"github.com/tile38/gows"
)

const dist = 100
const group = "people"

var pool *redis.Pool // The Tile38 connection pool
var srv *gows.Server // The websocket server

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
	srv = gows.New("/ws")
	srv.Static("/", "web")
	srv.Handle("Places", places)
	srv.Handle("Feature", feature)
	srv.Handle("Message", message)

	// Create an object and geofence for the Convention Center
	cc := readFence("convention-center")
	redisDo("SET", "places", "convention-center", "OBJECT", cc)
	go watch(gjson.Get(cc, "properties").String(), "WITHIN", group, "FENCE",
		"DETECT", "enter,exit", "OBJECT", cc)

	// Create and object and geofence for the Hyatt Regency
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

// watch continuously subscribes and listens for geofence notifications from
// Tile38
func watch(prop string, cmd string, args ...interface{}) {
	for {
		subscribe(prop, cmd, args...)
	}
}

// subscribe will listen for geofence notifications from Tile38, piping all
// notifications out to all connected websocket clients
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

		srv.Conns.Range(func(_ string, ws *websocket.Conn) {
			id := gjson.Get(msg, "id").String()
			idMD5 := fmt.Sprintf("%x", md5.Sum([]byte(id)))
			msg := strings.Replace(msg, id, idMD5, -1)
			if prop != "" {
				msg, _ = sjson.SetRaw(msg, "properties", prop)
			}
			ws.WriteMessage(websocket.TextMessage, []byte(msg))
		})
	}
}

func places(c gows.Context) error {
	// SCAN all places in Tile38
	places, err := redis.Values(redisDo("SCAN", "places"))
	if err != nil {
		log.Println("places: %v", err)
		return nil
	}

	if len(places) > 1 {
		ps, _ := redis.Values(places[1], nil)
		for _, p := range ps {
			kv, _ := redis.ByteSlices(p, nil)
			c.Send(string(kv[1]))
		}
	}
	return nil
}

// feature creates/updates a points location in Tile38, keyed by the ID in the
// message
func feature(c gows.Context) error {
	redisDo("SET", group, c.ConnID(), "EX", 5, "OBJECT", c.Message())
	return nil
}

func message(c gows.Context) error {
	feature := gjson.Get(c.Message(), "feature").String()

	// Get the connected clients from Tile38
	cc, err := connectedClients(
		gjson.Get(feature, "geometry.coordinates.0").Float(),
		gjson.Get(feature, "geometry.coordinates.1").Float())
	if err != nil {
		log.Println("connected-clients: %v", err)
		return nil
	}

	srv.Conns.Range(func(connID string, ws *websocket.Conn) {
		for ccID := range cc {
			if connID == ccID {
				newMsg, _ := sjson.Set(c.Message(), "feature.properties.via",
					cc[ccID])
				ws.WriteMessage(websocket.TextMessage, []byte(newMsg))
			}
		}
	})
	return nil
}

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
