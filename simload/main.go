package main

import (
	"encoding/hex"
	"flag"
	"log"
	"math/rand"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tidwall/gjson"
)

const frequency = time.Second
const spread = 0.06

var addr string
var clients int
var coords string

func main() {
	flag.StringVar(&addr, "a", ":8000", "server address")
	flag.IntVar(&clients, "n", 100, "number of clients")
	flag.StringVar(&coords, "c", "[-104.99649808,39.74254437]", "origin coordinates")

	flag.Parse()
	log.Printf("firing up %d clients", clients)
	for i := 0; i < clients; i++ {
		go runClient(i)
	}
	select {}
}

func runClient(idx int) {
	var b [12]byte
	rand.Read(b[:])
	id := hex.EncodeToString(b[:])
	color := "red"

	x := gjson.Get(coords, "0").Float() + (rand.Float64() * spread) - spread/2
	y := gjson.Get(coords, "1").Float() + (rand.Float64() * spread) - spread/2
	time.Sleep(time.Duration(rand.Float64() * float64(time.Second*2)))

	// move the point in the background
	go func() {
		tick := time.NewTicker(time.Millisecond * 250)
		for range tick.C {

		}
	}()

	for {
		func() {
			// connect to server
			ws, resp, err := websocket.DefaultDialer.Dial("ws://"+addr+"/ws", http.Header{})
			if err != nil {
				log.Printf("err %v: %v", idx, err)
				return
			}
			defer resp.Body.Close()
			defer ws.Close()
			log.Printf("connected %d", idx)
			defer log.Printf("disconnected %d", idx)

			var stop int32
			var wg sync.WaitGroup
			wg.Add(1)
			defer func() {
				atomic.StoreInt32(&stop, 1)
				wg.Wait()
			}()
			go func() {
				for atomic.LoadInt32(&stop) == 0 {
					me := `{"type": "Feature",
					"geometry": {"type":"Point","coordinates":[` +
						strconv.FormatFloat(x, 'f', -1, 64) + `,` +
						strconv.FormatFloat(y, 'f', -1, 64) + `]},
					"id":"` + id + `",
					"properties":{"color":"` + color + `"}}`
					ws.WriteMessage(1, []byte(me))
					time.Sleep(frequency)
				}
				wg.Done()
			}()
			for {
				_, _, err := ws.ReadMessage()
				if err != nil {
					log.Printf("err %v: %v", idx, err.Error())
					return
				}
			}
		}()
		time.Sleep(time.Second)

	}
}
