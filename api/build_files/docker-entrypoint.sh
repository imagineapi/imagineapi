#!/bin/sh

if npx directus database install; then
    echo "Database installed"

else 
    echo "Database already installed"
fi


# some migrations (like setting user) fail because they're not created yet (they're created below)
npx directus database migrate:latest

# notice that schema is applied after running migrations ... otherwise we get an error saying column "accountability" does not exist at character 57
npx directus schema apply --yes /directus/snapshot.json

# we need to create users manually since so we need to set passwords and token values from env variables
./create-users.sh
mkdir -p /directus/custom-extensions/migrations
cp /directus/custom-extensions/data-migrations/* /directus/custom-extensions/migrations/
npx directus database migrate:latest # since system migrations already ran this runs only data migrations

# copy uploads if they don't exist
if [ ! "$(ls -A /directus/uploads)" ]; then
    echo "Copying uploads"
    cp -R /directus/initial_uploads/* /directus/uploads/
fi

npx directus start