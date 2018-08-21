// ------ Variables ------
const expires = 4000;            // markers are auto removed after 5 seconds
const minUpdateFrequency = 200;  // minimum interval duration for posn updates
const maxUpdateFreqeuncy = 1000; // maximum interval duration for posn updates

let ws; // The websocket connection
let connected; // Whether or not the websocket is connected
let me; // Client state including location on the map
let markers = new Map(); // All markers. Using an ES6 Map for insertion order
let dragMarker; // The user draggable marker
let chatInput = document.getElementById('chat-input');

// ------ DEBUG ------

// window.setInterval(function () {
//     console.log(markers);
// }, 5000);

// ------ Main ------

// Load or generate the client state
loadMe();

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
map.on('load', function(){

    // The map is loaded, start up all systems.

    // Track map position and zoom
    let onmap = function() {
        me.properties.center = [map.getCenter().lng, map.getCenter().lat];
        me.properties.zoom = map.getZoom();
        storeMe();
    }
    map.on('drag', onmap);
    map.on('zoom', onmap);

    // create the transparent draggable marker
    createDragMarker(me.geometry.coordinates);
    createMarker(me, true);

    // establish the socket connection with the server
    openWS();

    // start the animations
    requestAnimationFrame(draw);

    // Continually send the client state. The 100ms is only a hint, sendMe() 
    // manages the actual throttling.
    setInterval(function(){ sendMe(true); }, 100);
    setInterval(function(){ expireMarkers(); }, 1000);

    // output some useful client information
    displayClientInfo();


    // make the canvas display element. All stuff is draw on this layer.
    var container = map.getCanvasContainer();
    canvas = document.createElement("canvas");
    canvas.style.position = 'absolute';
    container.appendChild(canvas);
    let resize = function(){
        var mcanvas = map.getCanvas();
        canvas.width = mcanvas.width;
        canvas.height = mcanvas.height;
        canvas.style.width = mcanvas.offsetWidth+"px";
        canvas.style.height = mcanvas.offsetHeight+"px";
        canvas.style.top = mcanvas.offsetTop+"px";
        canvas.style.left = mcanvas.offsetLeft+"px";
    }
    window.addEventListener('resize', resize);
    resize();
})



// ------ Functions ------


function displayClientInfo(){
    // Continuously update info fields
    window.setInterval(function () {
        document.getElementById('name').innerText = 'Name : ' + me.properties.name;
        document.getElementById('clientid').innerText = 'Client ID : ' + me.id;
        document.getElementById('position').innerText = 'Position : ' + 
            me.geometry.coordinates[0].toFixed(8)+','+me.geometry.coordinates[1].toFixed(8);
    }, 100);
}





// createDragMarker creates a transparent marker that tracks the users dot
// drag event. It's coordinate is then used to set the 'me' feature coordinate.
function createDragMarker(coords){
    let el = document.createElement('div');
    el.style.width = '32px';
    el.style.height = '32px';
    el.style.background = 'rgba(0,0,0,0.0)';
    el.style.zIndex = 4; // marker is the highest of all
    dragMarker = new mapboxgl.Marker({
        element: el,
        draggable: true
    })
    dragMarker.on('drag', function () {
        let coords = dragMarker.getLngLat();
        let marker = markers.get(me.id);
        me.geometry.coordinates = [coords.lng, coords.lat];
        storeMe();
    });
    dragMarker.setLngLat(coords);
    dragMarker.addTo(map);
}


// createMarker creates a marker and adds it to the markers hashmap. 
function createMarker(feature, anim){
    let marker = new mapboxgl.Marker({element: document.createElement('div')})
    marker.isme = feature.id == me.id;
    marker.nearbyFade = 0;
    if (anim) {
        marker.fade = 0;
        marker.fadeTween = new TWEEN.Tween(0)
            .to(1, 800)
            .easing(TWEEN.Easing.Bounce.Out)
            .onUpdate(function(v) {
                marker.fade = v;
            }).start();
    } else {
        marker.fade = 1;
    }
    marker.feature = feature;
    marker.setLngLat(feature.geometry.coordinates);
    marker.addTo(map);
    markers.set(feature.id, marker);
}

// updateMarker updates or creates a new marker based on the feature position.
// When nearby is provided and is a value true/false boolean then the marker
// nearby-connection lines are updated.
function updateMarker(feature, nearby, anim){
    let marker = markers.get(feature.id)
    if (!marker){
        createMarker(feature, anim);
        marker = markers.get(feature.id);
    } else if (marker.deleting) {
        return;
    } else {
        setMarkerFeature(marker, feature, anim);
    }
    marker.timestamp = new Date().getTime();

    // fill nearby stuff
    switch (nearby){
    case true:
        marker.nearbyTime = marker.timestamp;
        break;
    case false:
        marker.nearbyTime = 0;
        break;
    default:
        // undefined nearby
        return;
    }

    // fill nearby info
    if (marker.nearbyTween){
        marker.nearbyTween.stop();
        delete marker.nearbyTween;
    }

    if (anim){
        const dur = 200;
        let from = {v:marker.nearbyFade};
        let to, ease;
        if (nearby){
            // fade in
            ease = TWEEN.Easing.Quadratic.Out;
            to = {v:1};
        } else {
            // fade out
            ease = TWEEN.Easing.Quadratic.In;
            to = {v:0};
        }
        marker.nearbyTween = new TWEEN.Tween(from).to(to, dur)
            .easing(ease)
            .onUpdate(function(){
                marker.nearbyFade = from.v;
            }).start();
    } else {
        marker.nearbyFade = nearby?1:0;
    }



}

function deleteMarker(id, anim) {
    let marker = markers.get(id);
    if (!marker || marker.deleting){
        return;
    }
    marker.deleting = true;
    if (anim){
        if (marker.fadeTween){
            marker.fadeTween.stop();
            delete marker.fadeTween;
        }
        var o = {v:marker.fade}
        new TWEEN.Tween(o).to({v:0}, 800)
        .easing(TWEEN.Easing.Exponential.Out)
        .onUpdate(function() {
            marker.fade = o.v;
        }).onComplete(function(){
            marker.remove();
            markers.delete(id);
        }).start();
    } else {
        marker.remove();
        markers.delete(id);
    }
}


// setMarkerFeature sets the marker feature and animates it's position.
function setMarkerFeature(marker, feature, anim){
    if (marker.moveTween){
        marker.moveTween.stop();
        delete marker.moveTween;
    }
    var coords = {
        lng: marker.feature.geometry.coordinates[0],
        lat: marker.feature.geometry.coordinates[1],
    }
    var to = {
        lng: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
    }
    
    if (anim){
        if (coords.lng == to.lng && coords.lat == to.lat){
            return;
        }
        marker.moveTween = new TWEEN.Tween(coords)
            .to(to, minUpdateFrequency*2)
            .easing(TWEEN.Easing.Linear.None)
            .onUpdate(function() {
                marker.feature.geometry.coordinates[0] = coords.lng;
                marker.feature.geometry.coordinates[1] = coords.lat;
            }).start();
    } else {
        marker.feature = feature;
    }
}

// openWS creates a websocket connection to our GO geolocation service
function openWS() {
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = function () {
        console.log("socket opened")
        connected = true;
        sendMe(false);
    }
    ws.onclose = function () {
        console.log("socket closed");
        connected = false;
        setTimeout(function () { openWS(); }, 1000); // retry in one second
    }
    ws.onmessage = function (e) {
        let msg = JSON.parse(e.data);
        switch (msg.type){
        case "Update":
            updateMarker(msg.feature, undefined, true);
            break;
        case "Nearby":
            updateMarker(msg.feature, true, true);
            break;
        case "Faraway":
            updateMarker(msg.feature, false, true);
            break;
        }
    }
}

function randColor() {
    let r = Math.floor(Math.random() * 128 + 75)
    let g = Math.floor(Math.random() * 128 + 75)
    let b = Math.floor(Math.random() * 128 + 75)
    return '#'+r.toString(16)+g.toString(16)+b.toString(16);
}

function randID() {
    let id = '';
    while (id.length < 24){
        id += Math.floor(Math.random()*0xFFFFFF).toString(16);
    }
    return id.slice(0, 24)
}

// loadMe attempts to retrieve a previously stored location from sessionStorage, 
// otherwise it generates and sets a new one
function loadMe() {
    me = JSON.parse(sessionStorage.getItem('location'));
    if (!me) {
        let coords = [
            -104.99649808 + (Math.random() * 0.01) - 0.005,
            39.74254437 + (Math.random() * 0.01) - 0.005
        ];
        me = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: coords,
            },
            id: randID(),
            properties: {
                color: randColor(),
                center: coords,
                zoom: 14,
            }
        };
        console.log("created new state", me.id)
        storeMe()
    } else {
        console.log("loaded existing state", me.id)
    }
}

// storeMe stores our current location in sessionStorage
function storeMe() {
    let memsg = JSON.stringify(me);
    sessionStorage.setItem('location', memsg);
}


// sendMe send the current client state to the server. When 'throttled' is
// provided, the operation will ensure that a duplicate state is never sent
// more than once per 2000ms, and that a new state is never sent more than
// once per 200ms.
let lastMsg, lastTS;
function sendMe(throttled) {
    let now = new Date().getTime();
    let send = !throttled;
    let msg;
    if (!send){ 
        if (now > lastTS+maxUpdateFreqeuncy){
            send = true
        } else if (now > lastTS+minUpdateFrequency) {
            msg = JSON.stringify(me); 
            if (msg != lastMsg){
                send = true
            }
        }
    }
    if (send){
        //console.log("send state")
        if (!msg){
            msg = JSON.stringify(me);
        }
        sendMsg(msg);
        lastMsg = msg;
        lastTS = now;
    }
}

// sendMsg send a message to the server
function sendMsg(msg) {
    if (connected){
        ws.send(msg);
    }
}


function expireMarkers(){
    // the oldest markers will always be in the front
    let now = new Date().getTime();
    markers.forEach(function(marker, id){
        if (id != me.id){
            if (now > marker.timestamp+expires){
                deleteMarker(id, true)
            } else if (marker.nearbyTime && now > marker.nearbyTime+expires){
                updateMarker(marker.feature, false);
            }
        }
    })
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


// ------ Draw functions ------

function lineDistance(a, b){
    return Math.sqrt((b.x - a.x) * (b.x - a.x))
}

function lineAngle(a, b){
    return Math.atan2(b.y - a.y, b.x - a.x);
}

function lineDestination(a, angle, dist) {
    return {
        x: Math.cos(angle) * dist + a.x,
        y: Math.sin(angle) * dist + a.y
    }
}

function p(x) {
    return x*window.devicePixelRatio
}

function markerXY(marker) {
    let rect = marker.getElement().getBoundingClientRect();
    return {
        x: p(rect.left + rect.width/2),
        y: p(rect.top + rect.height/2)
    }
}

// Animation loop for all map drawings
function draw(time) {
    requestAnimationFrame(draw);
    TWEEN.update(time);

    let all = []; // list off all markers with the me-marker at the end.
    let memarker;
    // move all base markers in place
    markers.forEach(function(marker){
        if (marker.isme) {
            memarker = marker;
        } else {
            all.push(marker);
        }
        marker.setLngLat(marker.feature.geometry.coordinates);
    })
    all.push(memarker);

    // clear the canvas
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

        // draw the connections
        for (let i=0;i<all.length;i++){
            drawConnection(ctx, all[i], memarker);
        }
    
    
    // draw the markers
    for (let i=0;i<all.length;i++){
        drawMarker(ctx, all[i], memarker);
    }


}


const lineWidth = 4;
const markerSize = 28;

function drawConnection(ctx, marker, memarker){
    if (!marker.nearbyFade){
        return;
    }
    
    const innerSize = markerSize;
    
    // get some calcs to the me-marker
    let a = markerXY(marker);
    let b = markerXY(memarker);
    let dist = lineDistance(a, b)
    let angle = lineAngle(a, b)

    let fadeA = marker.fade*marker.nearbyFade;
    let fadeB = memarker.fade;
    
    let c;
    ctx.beginPath();
    ctx.fillStyle = "white";

    let pa1 = lineDestination(a, Math.PI/2+angle, p(innerSize*fadeA/2))
    let pa2 = lineDestination(a, -Math.PI/2+angle, p(innerSize*fadeA/2))
    let pa3 = lineDestination(a, angle, p(innerSize*fadeA/2)/2)

    let pb1 = lineDestination(b, -Math.PI/2+angle, p(innerSize*fadeB/2))
    let pb2 = lineDestination(b, Math.PI/2+angle, p(innerSize*fadeB/2))
    let pb3 = lineDestination(b, angle-Math.PI, p(innerSize*fadeB/2)/2)

    if (true){
        ctx.moveTo(pa1.x, pa1.y)
        ctx.lineTo(pa2.x, pa2.y)

        ctx.bezierCurveTo(pa3.x,pa3.y,pb3.x,pb3.y,pb1.x,pb1.y);
        ctx.lineTo(pb2.x, pb2.y)

        ctx.bezierCurveTo(pb3.x,pb3.y,pa3.x,pa3.y,pa1.x,pa1.y);
        // ctx.lineTo(pa2.x, pa2.y)
    } else {
        ctx.moveTo(pa1.x, pa1.y)
        ctx.lineTo(pa2.x, pa2.y)
        ctx.lineTo(pa3.x, pa3.y)
        
        ctx.lineTo(pb3.x, pb3.y)
        ctx.lineTo(pb2.x, pb2.y)
        ctx.lineTo(pb1.x, pb1.y)
        ctx.lineTo(pb3.x, pb3.y)

        ctx.lineTo(pa3.x, pa3.y)
        ctx.lineTo(pa1.x, pa1.y)
    }
    ctx.fill();

}


function drawMarker(ctx, marker, memarker){
    let a = markerXY(marker);




    
    
    
    
    
    
    
    
    // draw the marker circle

    let fade = marker.fade; // fade is the fade in/out transition



    // draw inner stroke
    ctx.beginPath();
    ctx.fillStyle = "white";
    ctx.arc(a.x, a.y, p(markerSize/2)*marker.fade, 0, 2*Math.PI);
    ctx.fill();

    // draw color overlay
    ctx.beginPath();
    ctx.fillStyle = marker.feature.properties.color;
    ctx.arc(a.x, a.y, p((markerSize-lineWidth*2)/2)*marker.fade, 0, 2*Math.PI);
    ctx.fill();

    // draw me dot
    if (marker == memarker){
        ctx.beginPath();
        ctx.fillStyle = "white";
        ctx.arc(a.x, a.y, p(lineWidth)*marker.fade, 0, 2*Math.PI);
        ctx.fill();
    }


    
    
}
