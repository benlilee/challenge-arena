#!/bin/bash
LOGFILE="/Users/ben/.qclaw/workspace/challenge-server/tunnel.log"
TUNNEL_URL=""

start_server() {
    cd /Users/ben/.qclaw/workspace/challenge-server
    pgrep -f "node server" || node server.js &
    echo "[$(date)] Server started/restarted" >> $LOGFILE
}

start_tunnel() {
    pkill -f "serveo.net" 2>/dev/null
    sleep 1
    ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -R 80:localhost:3000 serveo.net >> $LOGFILE 2>&1 &
    echo "[$(date)] Tunnel started" >> $LOGFILE
}

prevent_sleep() {
    pgrep caffeinate || caffeinate -d -i -s &
}

# Initial start
prevent_sleep
start_server
sleep 2
start_tunnel

# Monitor loop
while true; do
    sleep 30
    
    # Check server
    pgrep -f "node server" > /dev/null || start_server
    
    # Check tunnel
    if ! pgrep -f "serveo.net" > /dev/null; then
        echo "[$(date)] Tunnel died, restarting..." >> $LOGFILE
        start_tunnel
    fi
    
    # Check sleep prevention
    pgrep caffeinate > /dev/null || prevent_sleep
    
done
