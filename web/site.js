// ------ Variables ------

let ws; // The websocket connection
let connected; // Whether or not the websocket is connected
let me; // Our location on the map
let marker;
let markers = {}; // All markers that don't include ourself
let chatInput = document.getElementById('chat-input');

// ------ DEBUG ------

// window.setInterval(function () {
//     console.log(markers);
// }, 5000);

// ------ Main ------

getMe();

// Continuously update interpolated info fields
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
    style: 'mapbox://styles/sdwolfe32/cjkbw53fg1air2sqxfjo6sv2d',
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
        ws.send('{"type":"Viewport","data":' + JSON.stringify(map.getBounds()) + '}');
        storeMe();
    }
    map.on('drag', onmap);
    map.on('zoom', onmap);

    marker = makeMarker(true, me);
    renderCircle(me, '#a2d036');
    marker.addTo(map);
    marker.on('drag', function () {
        me.geometry.coordinates = [marker.getLngLat().lng, marker.getLngLat().lat];
        renderCircle(me, '#a2d036');
        storeMe();
        calcNearby();
    });
})


// ------ Functions ------

// renderCircle
function renderCircle(person, color) {
    let radius = 0.1;
    let options = {
        steps: 1000,
        units: 'kilometers'
    };
    let circle = turf.circle(person.geometry.coordinates, radius, options);
    renderLayer(person.properties.id, circle, color);
}

// renderLayer takes an identifier name, coordinates of a bounded geofence and a
// color and renders both a fill and border line on the map
function renderLayer(name, feature, color, outline) {
    if (map.getSource(name + '-fill') != undefined) {
        map.getSource(name + '-fill').setData(feature);
    } else {
        map.addLayer({
            'id': name + '-fill',
            'type': 'fill',
            'source': {
                'type': 'geojson',
                'data': feature,
            },
            'paint': {
                'fill-color': color,
                'fill-opacity': 0.25,
            }
        });
    }

    if (outline) {
        if (map.getSource(name + '-line') != undefined) {
            map.getSource(name + '-line').setData(feature);
        } else {
            map.addLayer({
                'id': name + '-line',
                'type': 'line',
                'source': {
                    'type': 'geojson',
                    'data': feature,
                },
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round',
                },
                'paint': {
                    'line-color': color,
                    'line-width': 2,
                }
            });
        }
    }
}

// openWS creates a websocket connection to our GO geolocation service
function openWS() {
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = function () {
        connected = true;
        storeMe();
        setInterval(function () {
            storeMe()
        }, 2000)
    }
    ws.onclose = function () {
        connected = false;
        setTimeout(function () {
            openWS()
        }, 1000)
    }
    ws.onmessage = function (e) {
        let msg = JSON.parse(e.data);

        console.log(msg);

        // Ignore messages about ourself
        if (msg.id == me.properties.id) {
            if (msg.command == 'set' && msg.properties) {
                if (msg.detect == 'enter') {
                    notify('You have entered : ' + msg.properties.name);
                }
                if (msg.detect == 'exit') {
                    notify('You have exited : ' + msg.properties.name);
                }
            }
            return;
        }

        switch (msg.command) {
            case 'set':
                if (!markers[msg.id]) {
                    markers[msg.id] = makeMarker(false, msg.object);
                    markers[msg.id].addTo(map);
                } else {
                    markers[msg.id].setLngLat(msg.object.geometry.coordinates);
                    markers[msg.id].getElement().
                    querySelector('.marker-name').innerText =
                        msg.object.properties.name ?
                        msg.object.properties.name :
                        'Anonymous';
                }
                markers[msg.id].person = msg.object;
                break;
            case 'del':
                if (markers[msg.id]) {
                    if (markers[msg.id].connected) {
                        let layerName = 'l:' + id;
                        let sourceName = 's:' + id;
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
                    me.properties.id = msg.id;
                    storeMe();
                }
                if (msg.type == 'Feature' && msg.geometry.type == 'Polygon') {
                    renderLayer(msg.properties.id, msg, '#a22427', true);
                }
                if (msg.type == 'Message') {
                    updateChat(msg);
                }
                break;
        }
        calcNearby();
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
        storeMe();
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

function calcNearby() {
    let linked;
    for (hash in markers) {
        pmarker = markers[hash];
        let meters = distance(pmarker, marker);
        let layerName = 'l:' + hash;
        let sourceName = 's:' + hash;
        if (meters < 100) {
            let data = {
                'type': 'Feature',
                'properties': {},
                'geometry': {
                    'type': 'LineString',
                    'coordinates': [
                        me.geometry.coordinates,
                        pmarker.person.geometry.coordinates
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
            pmarker.getElement().style.borderColor = '#a2d036';
            pmarker.linked = true;
            linked = true;
        } else {
            if (map.getLayer(layerName)) {
                map.removeLayer(layerName);
            }
            if (map.getSource(sourceName)) {
                map.removeSource(sourceName);
            }
            pmarker.getElement().style.borderColor = null;
            pmarker.linked = false;
        }
    }
    if (linked) {
        marker.getElement().style.borderColor = '#a2d036';
        document.getElementById('marker-dot').style.color = '#a2d036';
    } else {
        marker.getElement().style.borderColor = null;
        document.getElementById('marker-dot').style.color = null;
    }
}

function makeMarker(isme, person) {
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
    let marker = new mapboxgl.Marker({
        element: el,
        draggable: isme
    })
    marker.setLngLat(person.geometry.coordinates);
    return marker;
}

// notify places a greyed out italics message in the chat box notifying the user
function notify(message) {
    let messageDiv = document.createElement('div');
    messageDiv.innerHTML = '<a style="font-style:italic;opacity:0.5">' +
        message +
        '</div>';

    let chatArea = document.getElementById('chat-messages');
    chatArea.scrollTop = chatArea.scrollHeight - chatArea.clientHeight;
    chatArea.appendChild(messageDiv);
}

// updateChat updates the chat box to contain any new messages received
function updateChat(message) {
    let messageDiv = document.createElement('div');
    let b = document.createElement('b');
    b.style = "color:" + message.feature.properties.color + ";";
    b.innerText = message.feature.properties.name;
    messageDiv.appendChild(b);
    messageDiv.insertAdjacentText('beforeend', ' via (' +
        message.feature.properties.via + ') : ' + message.text);
    let chatArea = document.getElementById('chat-messages');
    chatArea.scrollTop = chatArea.scrollHeight - chatArea.clientHeight;
    chatArea.appendChild(messageDiv);
}

function distance(latA, lonA, latB, lonB) {
    if (arguments.length == 2) {
        var a = latA.getLngLat();
        var b = lonA.getLngLat();
        latA = a.lat;
        lonA = a.lng;
        latB = b.lat;
        lonB = b.lng;
    }

    // a = sin²(Δφ/2) + cos(φ1)⋅cos(φ2)⋅sin²(Δλ/2)
    // tanδ = √(a) / √(1−a)
    // see mathforum.org/library/drmath/view/51879.html for derivation

    var R = 6371e3;
    var φ1 = latA * Math.PI / 180,
        λ1 = lonA * Math.PI / 180;
    var φ2 = latB * Math.PI / 180,
        λ2 = lonB * Math.PI / 180;
    var Δφ = φ2 - φ1;
    var Δλ = λ2 - λ1;

    var a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c;

    return d;
};