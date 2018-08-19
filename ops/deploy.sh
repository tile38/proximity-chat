export CORE_IP=142.93.84.1
export SERVICE=proxychat.service

# Stop and delete any old unit
echo "Stopping and deleting old unit"
ssh core@$CORE_IP sudo systemctl daemon-reload
ssh core@$CORE_IP sudo systemctl stop $SERVICE
ssh core@$CORE_IP sudo rm -f /etc/systemd/system/$SERVICE
    
# Copy new unit file to machine
echo "Copying new unit file"
ssh core@$CORE_IP sudo systemctl daemon-reload
scp $SERVICE core@$CORE_IP:/home/core
ssh core@$CORE_IP sudo mv /home/core/$SERVICE /etc/systemd/system/$SERVICE

# Start the new unit
echo "Starting new unit"
ssh core@$CORE_IP sudo systemctl daemon-reload
ssh core@$CORE_IP sudo systemctl start $SERVICE