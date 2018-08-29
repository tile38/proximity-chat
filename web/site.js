// ------ Variables ------
const expires = 4000;            // markers are auto removed after 5 seconds
const minUpdateFrequency = 200;  // minimum interval duration for posn updates
const maxUpdateFrequency = 1500; // maximum interval duration for posn updates
const viewportFrequency = 500;   // 

const lineWidth = 4;
const messageDotSize = 4;
const markerSize = 32;


let ws; // The websocket connection
let connected; // Whether or not the websocket is connected
let me; // Client state including location on the map
let markers = new Map(); // All markers. Using an ES6 Map for insertion order
let dragMarker; // The user draggable marker
let nameInput;
let chatInput = document.getElementById('chat-input');
let hideReady = false;
let hidden = [];
let mcanvas;

let staticGeofenceFill = '#acd049' // '#690505';
let staticGeofenceLine = '#acd049' // '#725a5d';


let staticGeofenceData = './fences/convention-center.geojson';
let origin = [-104.99649808, 39.74254437];
let bounds = [-104.99938488006592, 39.74012836540008, -104.99406337738036, 39.74481418327878];

// let staticGeofenceData = './fences/galvanize.geojson';
// let origin = [-112.06693857908249,33.439893220138416];


// ------ DEBUG ------

// window.setInterval(function () {
//     console.log(markers);
// }, 5000);

// ------ Main ------

// Load or generate the client state
loadMe();
loadHidden();
loadChat();


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
    createNameInput();

    // establish the socket connection with the server
    openWS();

    // start the animations
    requestAnimationFrame(draw);

    // Continually send the client state. The 100ms is only a hint, sendMe() 
    // manages the actual throttling.
    setInterval(function(){ sendMe(true); }, 100);
    setInterval(function(){ expireMarkers(); }, 1000);
    setInterval(function(){ sendViewport(); }, viewportFrequency);


    // Bind the chat input keypress listener to its handler
    chatInput.addEventListener('keypress', function (ev) {
        let anim = true;
        if (ev.charCode == 13) {
            let message = this.value.trim();
            if (message[0] == '/'){
                if (message == '/clear'){
                    clearChat();
                } else if (message.indexOf('/name')==0){
                    let name = message.slice(6).trim();
                    me.properties.name = name;
                    storeMe();
                    sendMe();
                } else if (message == '/hide'){
                    hideReady = true
                }
                this.value = '';
                return
            }
            if (connected && message != '') {
                console.log(message)
                ws.send(JSON.stringify({
                    type: 'Message',
                    feature: me,
                    text: message
                }));
                this.value = '';

                if (anim){
                    startMessageAnim(markers.get(me.id))
                }
            }
        }
    })

    // add gps control

    let gc = new mapboxgl.GeolocateControl({
        position: 'top-left',
        positionOptions: {
            enableHighAccuracy: true
        },
        trackUserLocation: true,
        showUserLocation: false
    });
    
    gc.on('geolocate', function (loc) {
        me.geometry.coordinates = [loc.coords.longitude, loc.coords.latitude];
        dragMarker.setLngLat(me.geometry.coordinates);
        storeMe();
        sendMe();
        
    });
    
    gc.on('trackuserlocationstart', function() {
        dragMarker.dragDisabled = true;
    });

    gc.on('trackuserlocationend', function() {
        dragMarker.dragDisabled = false;
    });

    //let data = "./fences/convention-center.geojson"
    


    map.addLayer({
        "id": "static-geofence-fill",
        'type': 'fill',
        'source': {
            'type': 'geojson',
            'data': staticGeofenceData,
        },
        "paint": {
            'fill-color': staticGeofenceFill,
            'fill-opacity': 0.25
        }
    });
    map.addLayer({
        "id": "static-geofence-line",
        'type': 'line',
        'source': {
            'type': 'geojson',
            'data': staticGeofenceData,
        },
        "paint": {
            'line-color': staticGeofenceLine,
            'line-opacity': 1,
            'line-width': lineWidth
        }
    });

    // Add geolocate control to the map.
    map.addControl(gc)

    // make the canvas display element. All stuff is draw on this layer.
    let container = map.getCanvasContainer();
    canvas = document.createElement("canvas");
    //canvas.style.border = '1px solid red'
    canvas.style.position = 'absolute';
    container.appendChild(canvas);
    let resize = function(){
        let boxel = document.getElementById('chatbox');
        let mapel = document.getElementById('map');
        // mapel.style.left = boxel.offsetWidth+'px';
        // mapel.style.width = (document.body.offsetWidth-boxel.offsetWidth)+'px';
        mcanvas = map.getCanvas();  
        canvas.width = mapel.offsetWidth * window.devicePixelRatio;
        canvas.height = mapel.offsetHeight * window.devicePixelRatio;
        canvas.style.width = mapel.offsetWidth+"px";
        canvas.style.height = mapel.offsetHeight+"px";
        canvas.style.top = mapel.offsetTop+"px";
    }
    window.addEventListener('resize', resize);
    resize();
})

// window.addEventListener('mousemove', function(ev){
//     let rect = nameEl.getBoundingClientRect();
//     if (
//         ev.clientY > rect.top && 
//         ev.clientY < rect.top+rect.height && 
//         ev.clientX > rect.left && 
//         ev.clientX < rect.left+rect.width
//     ){
//         nameEl.style.opacity = 1.0
//     } else {
//         nameEl.style.opacity = 0.5
//     }

    
//     // console.log(, ev.clientY, rect.left, rect.top)
// });




// ------ Functions ------



function sendViewport(){
    sendMsg(JSON.stringify({'type':'Viewport','bounds':map.getBounds()}));
}

function displayClientInfo(){
    // Continuously update info fields
    window.setInterval(function () {
        document.getElementById('name').innerText = 'Name : ' + me.properties.name;
        document.getElementById('clientid').innerText = 'Client ID : ' + me.id;
        document.getElementById('position').innerText = 'Position : ' + 
            me.geometry.coordinates[0].toFixed(8)+','+me.geometry.coordinates[1].toFixed(8);
    }, 100);
}



function createNameInput(){
    nameEl = document.createElement("div")
    return;
    nameEl.innerHTML = '<input type="text" id="name-input">'
    nameEl.style.position = 'absolute'
    nameEl.style.zIndex = 5;
    nameEl.style.height = '30px';
    document.body.appendChild(nameEl);
    nameEl.addEventListener('mouseover', function(){
        console.log(123)
    })
    nameEl.addEventListener('mouseblur', function(){
        console.log(456)
    })

    let nameInput = document.getElementById('name-input');
    nameInput.maxLength = 15;
    nameInput.style.textAlign = 'center';
    nameInput.style.display = 'block';
    nameInput.style.font = 'bold '+ (20)+'px Sans-Serif';
    nameInput.style.color = 'transparent';
    nameInput.style.caretColor = 'black';
    nameInput.style.height = '30px';
    nameInput.style.background = 'transparent';
    nameInput.style.border = 0;
    nameInput.style.margin = 0;
    nameInput.style.padding = 0;
    nameInput.addEventListener('focus', function(){
        markers.get(me.id).overFade = 1
        nameInput.returnVal = me.properties.name;
        nameInput.value = '';
        me.properties.name = '';
        nameInput.watchI = setInterval(function(){
            let nval = nameInput.value.trim();
            if (nval != me.properties.name){
                me.properties.name = nval;
                nameInput.returnVal = me.properties.name;
                storeMe();
                sendMe();
            }
        }, 10);
    })
    nameInput.addEventListener('blur', function(){
        markers.get(me.id).overFade = 0;
        me.properties.name = nameInput.returnVal;
        clearInterval(nameInput.watchI);
    })
    nameInput.addEventListener('keypress', function(ev){
        if (ev.keyCode == 13){
            if (nameInput.value == ''){
                me.properties.name = '';
                nameInput.returnVal = me.properties.name;
                storeMe();
                sendMe();
            }
            nameInput.blur();
        }
    })
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
    dragMarker.on('drag', function (ev) {
        if (dragMarker.dragDisabled){
            return;
        }
        let coords = dragMarker.getLngLat();
        let marker = markers.get(me.id);
        me.geometry.coordinates = [coords.lng, coords.lat];
        storeMe();
    });
    dragMarker.setLngLat(coords);
    dragMarker.addTo(map);
    el.addEventListener('mouseover', function(){
        setMarkerOverOut(markers.get(me.id), true, true)
    })
    el.addEventListener('mouseout', function(){
        setMarkerOverOut(markers.get(me.id), false, true)
    })
}


// createMarker creates a marker and adds it to the markers hashmap. 
function createMarker(feature, anim){
    let el = document.createElement('div');
    el.style.width = '32px';
    el.style.height = '32px';
    //el.style.background = 'blue';
    let marker = new mapboxgl.Marker({element: el})
    marker.isme = feature.id == me.id;
    marker.nearbyFade = 0;
    marker.messageFades = {};
    marker.messageFadeIdx = 0;
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
    el.addEventListener('mouseover', function(){
        setMarkerOverOut(marker, true, true)
    })
    el.addEventListener('mouseout', function(){
        setMarkerOverOut(marker, false, true)
    })
    el.addEventListener('click', function(){
        if (hideReady){
            storeHide(marker);
            hideReady = false;
        }
    })

    for (let i=0;i<hidden.length;i++){
        if (hidden[i] == feature.id){
            marker.hidden = true;
            break;
        }
    }
}


window.addEventListener('click', function(){
    if (hideReady){
        console.log("hide canceled");
        hideReady = false;
    }
})

function setMarkerOverOut(marker, over, anim){
    if (anim){
        if (marker.overTween){
            marker.overTween.stop();
            delete marker.overTween;
        }
        let from = {v:marker.overFade}
        let to = {v:over?1:0}
        let ease = over?TWEEN.Easing.Quadratic.In:TWEEN.Easing.Quadratic.Out;
        marker.overTween = new TWEEN.Tween(from)
        .to(to, 300)
        .easing(ease)
        .onUpdate(function(){
            marker.overFade = from.v;
        }).start();
    }else{
        if (over){
            maker.overFade = 1;
        }else{
            maker.overFade = 0;
        }
    }
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
        const dur = 300;
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
        let o = {v:marker.fade}
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
    let coords = {
        lng: marker.feature.geometry.coordinates[0],
        lat: marker.feature.geometry.coordinates[1],
    }
    let to = {
        lng: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
    }
    marker.feature.properties.name = feature.properties.name
    if (anim){
        const dur = 400;
        if (coords.lng == to.lng && coords.lat == to.lat){
            return;
        }
        marker.moveTween = new TWEEN.Tween(coords)
            .to(to, dur)
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
    ws = new WebSocket((location.protocol=='https:'?'wss:':'ws:')+'//' + location.host + '/ws');
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
            for (let i=0;i<msg.features.length;i++){
                updateMarker(msg.features[i], undefined, true);
            }
            break;
        case "Nearby":
            updateMarker(msg.feature, true, true);
            break;
        case "Faraway":
            updateMarker(msg.feature, false, true);
            break;
        case "Message":
            updateChat(msg.feature, msg.text, true);
            storeChat(msg.feature, msg.text)
            break;
        case "Inside":
             if (!msg.me){
                updateMarker(msg.feature, undefined, true);
                updateStatic(msg.feature.id, true)
            } else {
                updateStatic(me.id, true)
            }
            break;
        case "Outside":
            if (!msg.me){
                updateMarker(msg.feature, undefined, true);
                updateStatic(msg.feature.id, false)
            } else {
                updateStatic(me.id, false)
            }
            break;
        }
    }
}

function updateStatic(id, inside){
    let marker = markers.get(id)
    if (marker){
        marker.staticInside = inside;
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

function randCoords() {
    while (true){
         let coords = [
            origin[0] + (Math.random() * 0.005) - 0.0025,
            origin[1] + (Math.random() * 0.005) - 0.0025
        ];
        if (coords[0]<bounds[0]||coords[0]>bounds[2]||
            coords[1]<bounds[1]||coords[1]>bounds[3]){
            return coords;
         }
    }
}

// loadMe attempts to retrieve a previously stored location from sessionStorage, 
// otherwise it generates and sets a new one
function loadMe() {
    me = JSON.parse(sessionStorage.getItem('location'));
    if (!me) {
        me = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: randCoords(),
            },
            id: randID(),
            properties: {
                color: randColor(),
                center: origin,
                zoom: 15,
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
        if (now > lastTS+maxUpdateFrequency){
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
function updateChat(feature, text, anim) {
    for (let i=0;i<hidden.length;i++){
        if (feature.id == hidden[i]){
            return;
        }
    }
    let el = document.createElement('div');
    el.className = 'chat-text'
    el.style.width = '100%';
    el.style.margin = '5px 0';

    let dotCanvas = document.createElement('canvas');
    let dotSize = 20;
    dotCanvas.width = dotSize*window.devicePixelRatio;
    dotCanvas.height = dotSize*window.devicePixelRatio;
    dotCanvas.style.width = dotSize+'px';
    dotCanvas.style.height = dotSize+'px';
    dotCanvas.style.display = 'inline';
    dotCanvas.style.marginRight = '5px';
    drawMarkerDot(dotCanvas.getContext('2d'), 
        dotSize*window.devicePixelRatio/2, dotSize*window.devicePixelRatio/2, 
        dotSize, 3, 
        feature.properties.color, 1, false);
    el.appendChild(dotCanvas);

    let textEl = document.createElement('span');

    if (feature.properties.name){
        let nameEl = document.createElement('span');
        nameEl.style.fontSize = '17px';
        nameEl.style.position = 'relative';
        nameEl.style.top = '-3px';
        nameEl.style.fontWeight = 'bold';
        nameEl.innerText = feature.properties.name+": ";
        el.appendChild(nameEl);
        
    }

    textEl.innerText = text;
    textEl.style.fontSize = '17px';
    textEl.style.position = 'relative';
    textEl.style.top = '-3px';
    el.appendChild(textEl);

    

    // add to message box
    let chatArea = document.getElementById('chat-messages');
    chatArea.appendChild(el);
    if (chatArea.autoScroll){
        chatArea.scrollTop = chatArea.scrollHeight - chatArea.clientHeight;
    }

    if (anim){
        let marker = markers.get(feature.id)
        if (!marker) {
            return;
        }
        startMessageAnim(marker)
    }
}


function loadHidden(){
    hidden = sessionStorage.getItem('hidden');
    if (!hidden) {
        hidden = [];
    } else {
        hidden = JSON.parse(hidden);
    }
}

function storeHide(marker){
    marker.hidden = true;
    hidden.push(marker.feature.id);
    sessionStorage.setItem('hidden', JSON.stringify(hidden));

    document.getElementById('chat-messages').innerHTML = '';
    loadChat();
}

function storeChat(feature, text){
    let idx = parseInt(sessionStorage.getItem('chat-count'))||0;
    sessionStorage.setItem('chat-'+idx+'-feature', JSON.stringify(feature));
    sessionStorage.setItem('chat-'+idx+'-text', text)
    sessionStorage.setItem('chat-count', idx+1);
}

function loadChat(){
    let chatArea = document.getElementById('chat-messages');
    chatArea.addEventListener("scroll", function(){
        chatArea.autoScroll = 
            chatArea.scrollTop == chatArea.scrollHeight - chatArea.clientHeight;
    })
    let count = parseInt(sessionStorage.getItem('chat-count'))||0;
nextText:
    for (let i=0;i<count;i++){
        let feature = JSON.parse(sessionStorage.getItem('chat-'+i+'-feature'));
        for (let j=0;j<hidden.length;j++){
            if (feature.id == hidden[j]){
                continue nextText;
            }
        }
        let text = sessionStorage.getItem('chat-'+i+'-text');
        updateChat(feature, text, false);
    }
    chatArea.scrollTop = chatArea.scrollHeight - chatArea.clientHeight;
    chatArea.autoScroll = true;
}

function clearChat(){
    sessionStorage.setItem('chat-count', 0);
    document.getElementById('chat-messages').innerHTML = '';

}

function startMessageAnim(marker){
    let idx = marker.messageFadeIdx;
    marker.messageFadeIdx++;
    marker.messageFades[idx] = 0;
    new TWEEN.Tween(0)
        .to(1, 600)
        .easing(TWEEN.Easing.Quadratic.Out)
        .onUpdate(function(v) {
            marker.messageFades[idx] = v;
        })
        .onComplete(function(){
            delete marker.messageFades[idx];
        })
        .start();
}


// ------ Draw functions ------

function lineDistance(a, b){
    let a1 = a.x - b.x;
    let b1 = a.y - b.y;

    return Math.sqrt( a1*a1 + b1*b1 );
    //return Math.sqrt((b.x - a.x) * (b.y - a.y))
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
    let mapel = document.getElementById('map');
    
    return {
        x: p(rect.left + rect.width/2 - mapel.offsetLeft),
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
        } else if (marker.hidden){
            return;
        } else {
            all.push(marker);
        }
        marker.setLngLat(marker.feature.geometry.coordinates);
    })
    all.push(memarker);

    // clear the canvas
    let ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // draw the label text
    for (let i=0;i<all.length;i++){
        drawLabel(ctx, all[i], false);
    }

    // draw the connections
    for (let i=0;i<all.length;i++){
        drawConnection(ctx, all[i], memarker);
    }

    // draw the message dots
    for (let i=0;i<all.length;i++){
        drawMessageDot(ctx, all[i], memarker);
    }

    // draw the markers
    for (let i=0;i<all.length;i++){
        drawMarker(ctx, all[i], memarker);
    }

    // draw the overlay label text
    for (let i=0;i<all.length;i++){
        drawLabel(ctx, all[i], true);
    }
    
    let a = markerXY(memarker);
    let mr = memarker.getElement().getBoundingClientRect();
    nameEl.style.top = (mr.top - nameEl.offsetHeight) + 'px';
    nameEl.style.left = ((mr.left + mr.width/2) - nameEl.offsetWidth/2) + 'px';


}

function drawLabel(ctx, marker, overlay){
    if (overlay&&!marker.overFade){
        return
    }
    let text = marker.feature.properties.name
    if (!text){
        return;
    }
    let labelSize = 20;
    let a = markerXY(marker);
    ctx.font = "bold "+(labelSize*marker.fade*window.devicePixelRatio)+"px Sans-Serif";
    let measure = ctx.measureText(text)

    if (overlay){
        ctx.fillStyle = 'rgba(47,64,75,'+(marker.overFade)+')'
        //ctx.strokeStyle = 'rgba(255,255,255,'+(0.5*marker.overFade)+')'
        //ctx.lineWidth = p(lineWidth)/1.8;
        //ctx.strokeText(text, a.x-measure.width/2, a.y-(markerSize+lineWidth*3)*marker.fade);    
    }else{
        ctx.fillStyle = '#809bad';
    }
    ctx.fillText(text, a.x-measure.width/2, a.y-(markerSize+p(5))*marker.fade);
}

function drawConnection(ctx, marker, memarker){
    if (!marker.nearbyFade){
        return;
    }
    
    const innerSize = markerSize*.75;
    
    // get some calcs to the me-marker
    let a = markerXY(marker);
    let b = markerXY(memarker);
    let angle = lineAngle(a, b)

    let fadeA = marker.fade*marker.nearbyFade;
    let fadeB = memarker.fade;
    
    let c;
    ctx.beginPath();
    //ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillStyle = "rgba(255,255,255,1)";

    let pa1 = lineDestination(a, Math.PI/2+angle, p(innerSize*fadeA/2))
    let pa2 = lineDestination(a, -Math.PI/2+angle, p(innerSize*fadeA/2))
    let pa3 = lineDestination(a, angle, p(innerSize*fadeA/2)/2)

    let pb1 = lineDestination(b, -Math.PI/2+angle, p(innerSize*fadeB/2))
    let pb2 = lineDestination(b, Math.PI/2+angle, p(innerSize*fadeB/2))
    let pb3 = lineDestination(b, angle-Math.PI, p(innerSize*fadeB/2)/2)

    ctx.moveTo(pa1.x, pa1.y)
    ctx.lineTo(pa2.x, pa2.y)

    ctx.bezierCurveTo(pa3.x,pa3.y,pb3.x,pb3.y,pb1.x,pb1.y);
    ctx.lineTo(pb2.x, pb2.y)

    ctx.bezierCurveTo(pb3.x,pb3.y,pa3.x,pa3.y,pa1.x,pa1.y);
    ctx.fill();
}

function drawMessageDot(ctx, marker, memarker){
    if (!marker.nearbyFade){
        return;
    }

    let a = markerXY(marker);
    let b = markerXY(memarker);
    let dist = lineDistance(a, b)
    let angle = lineAngle(a, b)

    for (let idx in memarker.messageFades){
        let fade = memarker.messageFades[idx];

        let p4 = lineDestination(b, angle-Math.PI, dist*fade);
        ctx.beginPath();
        ctx.fillStyle = "white";
        ctx.arc(p4.x, p4.y, p(messageDotSize+2)*marker.fade*marker.nearbyFade, 0, 2*Math.PI);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = memarker.feature.properties.color;
        ctx.arc(p4.x, p4.y, p(messageDotSize)*marker.fade*marker.nearbyFade, 0, 2*Math.PI);
        ctx.fill();
    }

    for (let idx in marker.messageFades){
        let fade = marker.messageFades[idx];

        let p4 = lineDestination(a, angle, dist*fade);
        ctx.beginPath();
        ctx.fillStyle = "white";
        ctx.arc(p4.x, p4.y, p(messageDotSize+2)*marker.fade*marker.nearbyFade, 0, 2*Math.PI);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = marker.feature.properties.color;
        ctx.arc(p4.x, p4.y, p(messageDotSize)*marker.fade*marker.nearbyFade, 0, 2*Math.PI);
        ctx.fill();
    }
}

function drawMarker(ctx, marker, memarker){
    let a = markerXY(marker);
    let color = marker.feature.properties.color;
    if (marker.staticInside){
        drawGopher(ctx, a.x, a.y, color, marker.fade, marker == memarker)
    }else {
        drawMarkerDot(ctx, a.x, a.y,
            markerSize, lineWidth,
            color, marker.fade, 
            marker == memarker);
    }
}

function drawMarkerDot(ctx, x, y, markerSize, lineWidth, color, fade, isme){
    // draw inner stroke
    ctx.beginPath();
    ctx.fillStyle = "white";
    ctx.arc(x, y, p(markerSize/2)*fade, 0, 2*Math.PI);
    ctx.fill();

    // draw color overlay
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, p((markerSize-lineWidth*2)/2)*fade, 0, 2*Math.PI);
    ctx.fill();

    // draw me dot
    if (isme){
        ctx.beginPath();
        ctx.fillStyle = "white";
        ctx.arc(x, y, p(lineWidth)*fade, 0, 2*Math.PI);
        ctx.fill();
    }
}

var img = new Image;
img.src = "gopher.png";


function drawGopher(ctx, x, y, color, fade, isme){
    let width = p(markerSize*1.1)*fade;
    let height = p((markerSize*1.1/img.width)*img.height)*fade;

    // draw bg
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.moveTo(x-width/2+width*0.1,y-height/2+height*0.1)
    ctx.lineTo(x+width/2-width*0.1,y-height/2+height*0.1)
    ctx.lineTo(x+width/2-width*0.15,y+height/2-height*0.1)
    ctx.lineTo(x-width/2+width*0.15,y+height/2-height*0.1)
    ctx.fill();

    ctx.drawImage(img, x-width/2, y-height/2, width, height);

    // // draw me dot
    // if (isme){
    //     ctx.beginPath();
    //     ctx.fillStyle = "white";
    //     ctx.arc(x, y+height/6, p(lineWidth/2)*fade, 0, 2*Math.PI);
    //     ctx.fill();
    // }
    
}
