// ------ Variables ------

let ws; // The websocket connection
let connected; // Whether or not the websocket is connected
let me; // Our location on the map
let markers = {}; // All markers on the map
let chatInput = document.getElementById('chat-input');

// ------ DEBUG ------

// window.setInterval(function () {
//     console.log(markers);
// }, 5000);

// ------ Main ------

getMe();

// Continuously update info fields
window.setInterval(function () {
    document.getElementById('name').innerText = 'Name : ' + me.properties.name;
    document.getElementById('clientid').innerText = 'Client ID : ' + me.properties.id;
    document.getElementById('position').innerText = 'Position : ' + me.geometry.coordinates;
}, 10);

// Bind the chat input keypress listener to its handler
chatInput.addEventListener('keypress', function (ev) {
    if (ev.charCode == 13) {
        let message = this.value.trim();
        if (connected && message != '') {
            ws.send(JSON.stringify({
                type: 'Message',
                feature: me,
                text: message
            }));
            this.value = '';
        }
    }
})

// Load the map
mapboxgl.accessToken = 'pk.eyJ1Ijoic2R3b2xmZTMyIiwiYSI6ImNqa2JxdHcxOTAzMHQza241dmo4NTR6cmwifQ.JP0VMlXnDthDlYp0mVViXA';
let map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/sdwolfe32/cjkvl0av304r42sphvsm0odyw',
    center: me.properties.center,
    zoom: me.properties.zoom,
    keyboard: false,
});

// Set the maps on load functionality
map.on('load', function () {
    // Form a new websocket connection
    openWS();

    // Track map position and zoom
    let onmap = function () {
        me.properties.center = [map.getCenter().lng, map.getCenter().lat];
        me.properties.zoom = map.getZoom();
        sendViewport();
        storeMe();
    }
    map.on('drag', onmap);
    map.on('zoom', onmap);
})


// ------ Functions ------

// openWS creates a websocket connection to our GO geolocation service
function openWS() {
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = function () {
        connected = true;
        storeMe();

        // Renotify the server we still exist every 25 seconds
        setInterval(function () {
            storeMe();
            sendViewport();
        }, 1000)
    }
    ws.onclose = function () {
        connected = false;
        setTimeout(function () {
            openWS()
        }, 1000)
    }
    ws.onmessage = function (e) {
        let msg = JSON.parse(e.data);

        // For roaming notifications
        if (msg.detect && msg.detect == 'roam') {
            // If I'm part of this geofence
            if ((msg.id == me.properties.id) ||
                (msg.nearby && msg.nearby.id == me.properties.id) ||
                (msg.faraway && msg.faraway.id == me.properties.id)) {
                calcNearby(msg);
            }
            return;
        }

        // Ignore any other messages about ourself
        if (msg.id == me.properties.id) {
            return;
        }

        // Override viewport exits to delete command
        if (msg.hook &&
            msg.hook.includes('viewport:') &&
            msg.detect == 'exit') {
            msg.command = 'del'
        }

        switch (msg.command) {
            case 'set':
                createMarker(msg.id, msg.object);
                break;
            case 'del':
                if (markers[msg.id]) {
                    if (markers[msg.id].connected) {
                        let layerName = 'l:' + msg.id;
                        let sourceName = 's:' + msg.id;
                        if (map.getLayer(layerName)) {
                            map.removeLayer(layerName);
                        }
                        if (map.getSource(sourceName)) {
                            map.removeSource(sourceName);
                        }
                    }
                    markers[msg.id].remove(map);
                    delete markers[msg.id];
                }
                break;
            default:
                if (msg.type == 'ID') {
                    // When we get our ID, render our marker and make it 
                    // draggable
                    markers[msg.id] = renderMarker(true, me);
                    markers[msg.id].addTo(map);
                    markers[msg.id].on('drag', function () {
                        me.geometry.coordinates = [markers[msg.id].getLngLat().lng,
                            markers[msg.id].getLngLat().lat
                        ];
                        storeMe();
                    });
                    me.properties.id = msg.id;
                    storeMe();
                    sendViewport();
                }
                if (msg.type == 'Feature') {
                    if (msg.properties.id == me.properties.id) {
                        return;
                    }
                    if (msg.geometry.type == 'Point') {
                        createMarker(msg.properties.id, msg);
                    }
                }
                if (msg.type == 'Message') {
                    updateChat(msg);
                }
                break;
        }
    }
}

// getMe attempts to retrieve a previously stored location from sessionStorage, 
// otherwise it generates and sets a new one
function getMe() {
    me = JSON.parse(sessionStorage.getItem('location'));

    if (!me) {
        me = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [-104.9964980827933 + (Math.random() * 0.01) - 0.005,
                    39.74254437567595 + (Math.random() * 0.01) - 0.005
                ]
            },
            properties: {
                id: 'Unknown',
                color: 'rgba(' +
                    Math.floor(Math.random() * 128 + 128) + ',' +
                    Math.floor(Math.random() * 128 + 128) + ',' +
                    Math.floor(Math.random() * 128 + 128) + ',' +
                    '1.0)',
            }
        };
        me.properties.center = me.geometry.coordinates;
        me.properties.zoom = 14;
    }
}

// storeMe stores our current location in sessionStorage and broadcasts it to 
// the websocket server
function storeMe() {
    let memsg = JSON.stringify(me);
    sessionStorage.setItem('location', memsg);
    if (!connected) {
        return;
    }
    ws.send(memsg);
}

function sendViewport() {
    ws.send('{"type":"Viewport","data":' + JSON.stringify(map.getBounds()) + '}');
}

function calcNearby(roammsg) {
    let id;
    let linked = roammsg.nearby;

    // Pick the ID that isn't ours
    if (roammsg.id == me.properties.id) {
        if (roammsg.nearby) {
            id = roammsg.nearby.id;
        } else {
            id = roammsg.faraway.id;
        }
    } else {
        id = roammsg.id;
    }

    let layerName = 'l:' + id;
    let sourceName = 's:' + id;

    // Add or remove the linking line
    if (markers[id]) {
        if (linked) {
            let data = {
                'type': 'Feature',
                'properties': {},
                'geometry': {
                    'type': 'LineString',
                    'coordinates': [
                        me.geometry.coordinates,
                        markers[id].person.geometry.coordinates
                    ]
                }
            }
            if (map.getSource(sourceName)) {
                map.getSource(sourceName).setData(data);
            } else {
                map.addSource(sourceName, {
                    type: 'geojson',
                    data: data,
                });
                map.addLayer({
                    'id': layerName,
                    'type': 'line',
                    'source': sourceName,
                    'layout': {
                        'line-join': 'round',
                        'line-cap': 'round'
                    },
                    'paint': {
                        'line-color': '#a2d036',
                        'line-width': 3
                    }
                });
            }
            markers[id].getElement().style.borderColor = '#a2d036';
            markers[id].connected = true;
        } else {
            if (map.getLayer(layerName)) {
                map.removeLayer(layerName);
            }
            if (map.getSource(sourceName)) {
                map.removeSource(sourceName);
            }
            markers[id].getElement().style.borderColor = null;
            markers[id].connected = false;
        }
    }

    // Update our marker
    if (linked) {
        markers[me.properties.id].getElement().style.borderColor = '#a2d036';
        document.getElementById('marker-dot').style.color = '#a2d036';
    } else {
        markers[me.properties.id].getElement().style.borderColor = null;
        document.getElementById('marker-dot').style.color = null;
    }
}

function createMarker(id, feature) {
    if (!markers[id]) {
        // Create marker if it doesn't currently exist
        markers[id] = renderMarker(false, feature);
        markers[id].addTo(map);
    } else {
        // Update the marker if it exists
        markers[id].setLngLat(feature.geometry.coordinates);
        markers[id].getElement().
        querySelector('.marker-name').innerText =
            feature.properties.name ?
            feature.properties.name :
            'Anonymous';
    }
    markers[id].person = feature;
}

function renderMarker(isme, person) {
    let el = document.createElement('div');
    el.className = 'marker';
    el.style.backgroundColor = person.properties.color;
    if (isme) {
        let ed = document.createElement('input');
        ed.value = person.properties.name ? person.properties.name : '';
        ed.type = 'text';
        ed.placeholder = 'enter your name';
        ed.id = 'name';
        ed.autocomplete = 'off';
        ed.maxLength = 28;
        ed.onkeypress = ed.onchange = ed.onkeyup = function (ev) {
            person.properties.name = ed.value.trim();
            storeMe()
            if (ev.charCode == 13) {
                this.blur();
            }
        }
        el.appendChild(ed);
        el.style.zIndex = 10000;
        el.style.cursor = 'move';
        let dot = document.createElement('div');
        dot.id = 'marker-dot';
        el.appendChild(dot);
    } else {
        let ed = document.createElement('div');
        ed.className = 'marker-name';
        ed.innerText =
            person.properties.name ? person.properties.name : 'Anonymous';
        el.appendChild(ed);
    }
    let newMarker = new mapboxgl.Marker({
        element: el,
        draggable: isme
    })
    newMarker.setLngLat(person.geometry.coordinates);
    return newMarker;
}

// updateChat updates the chat box to contain any new messages received
function updateChat(message) {
    let messageDiv = document.createElement('div');
    let b = document.createElement('b');
    b.style = "color:" + message.feature.properties.color + ";";
    b.innerText = message.feature.properties.name;
    messageDiv.appendChild(b);
    messageDiv.insertAdjacentText('beforeend', ' : ' + message.text);
    let chatArea = document.getElementById('chat-messages');
    chatArea.scrollTop = chatArea.scrollHeight - chatArea.clientHeight;
    chatArea.appendChild(messageDiv);
}