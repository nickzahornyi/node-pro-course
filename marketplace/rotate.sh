#!/bin/sh
set -eu

cd "$(dirname "$0")"
# Read the effective application configuration, including Compose overrides.
compose_config="$(docker compose config --format json)"
db_role="$(printf '%s' "$compose_config" | node --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; const u=new URL(JSON.parse(s).services.app.environment.DB_URL); const role=decodeURIComponent(u.username); if (!role) throw new Error("DB_URL requires a role"); process.stdout.write(role);')"
db_name="$(printf '%s' "$compose_config" | node --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; const u=new URL(JSON.parse(s).services.app.environment.DB_URL); const db=decodeURIComponent(u.pathname.slice(1)); if (!db) throw new Error("DB_URL requires a database"); process.stdout.write(db);')"
new_password="$(openssl rand -hex 24)"

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_role" -d "$db_name" \
  -v role="$db_role" -v new_password="$new_password" <<'SQL'
ALTER ROLE :"role" WITH PASSWORD :'new_password';
SQL
printf '%s\n' "$new_password" | docker compose exec -T -u 0 db sh -c 'cat > /run/secrets/db_password; chmod 644 /run/secrets/db_password'
# Same credential resource feeds the app and PgBouncer. Never write a rotated secret to Git.
printf '%s\n%s\n' "$db_role" "$new_password" | node --input-type=module -e '
let input=""; for await (const c of process.stdin) input+=c;
const [role,password]=input.trimEnd().split("\n");
const quote=value=>String.fromCharCode(34)+value.replaceAll(String.fromCharCode(34),String.fromCharCode(34,34))+String.fromCharCode(34);
process.stdout.write(quote(role)+" "+quote(password)+"\n");
' | docker compose exec -T -u 0 db sh -c 'cat > /run/secrets/userlist.txt; chmod 644 /run/secrets/userlist.txt'
docker compose kill -s HUP pgbouncer
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_role" -d "$db_name" \
  -v role="$db_role" <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE usename = :'role' AND pid <> pg_backend_pid();
SQL

echo "Database password rotated; the application process was not restarted."
