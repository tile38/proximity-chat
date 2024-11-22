# Proximity Chat

A chat application that only allows for chatting in real-time with people that 
are within 200 meters of you. It works with the help of
[Tile38](https://github.com/tidwall/tile38).


[Video Presentation](https://www.youtube.com/watch?v=fVoML1vAW2c&t=15s) at GopherCon 2018.

## Running

Make sure that Tile38 is running.

```
go run main.go
```

Now go to http://localhost:8000

GPS Tracking is turned off and the application is running in simulation mode.  
Drag your marker around the map.  
Open up another browser window and drag it's marker near the first marker.

Now chat.

<img width="600" alt="image" src="https://github.com/user-attachments/assets/ad5ac3a9-9e16-4316-9574-e14c55dfa51d">


