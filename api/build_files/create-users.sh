#!/bin/sh

echo "Creating bot user"
# grep is used to get the id of of the user and ignore the rest of the output
output=$(npx directus users create --email bot@example.com --password "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c20; echo)" --role $CONSUMER_ROLE_ID)
botUserCreationExitStatus=$?

# Assuming if bot user exists, then the rest of the users exist
if [ $botUserCreationExitStatus -eq 0 ]; then
    echo "Creating users"
    # bot user
    BOT_USER_ID=$(echo "$output" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
    node ./user-token.js $BOT_USER_ID $BOT_TOKEN $DB_HOST $DB_PORT $DB_USER $DB_PASSWORD $DB_DATABASE
    
    # standar user
    echo "Creating standard user"
    npx directus users create --email $STANDARD_USER_EMAIL --password $STANDARD_USER_PASSWORD --role $STANDARD_ROLE_ID
else
    echo "Bot user already exists"
    echo "Not creating standard user either"
fi