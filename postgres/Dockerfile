FROM postgres:15.2

# This should be removed and handle using snapshots and migrations in directus
COPY ./seed.sql /docker-entrypoint-initdb.d/init.sql 

EXPOSE 5432
 