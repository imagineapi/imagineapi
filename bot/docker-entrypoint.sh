#!/bin/sh

/usr/src/app/proxy-cert-install.sh

file_path="/usr/src/app/proc/info"
if [ -e "$file_path" ]; then
    echo "proc_info file exists"
else
    uuid=$(dbus-uuidgen)
    # lowercase generated channel name because Discord requires it lowercased and with dashes
    CHANNEL_NAME=$(npm run --silent gfynonce | tr '[:upper:]' '[:lower:]')
    echo "#DO NOT CHANGE THESE VALUES OTHERWISE ImagineAPI.dev MAY NOT FUNCTION" > "$file_path" # > is used to clear prior file contents
    echo "INSTANCE_ID=$uuid" >> "$file_path"
    echo "CHANNEL_NAME=$CHANNEL_NAME" >> "$file_path"
    echo "Created proc_info file"
fi

# not using npm run start because npm takes over sigterm and we can't get a graceful shutdown
node dist/consumer.js