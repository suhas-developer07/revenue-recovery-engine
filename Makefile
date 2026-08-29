# Load .env file
include .env
export

migrationPath=./migrations

.PHONY: up down logs migrate reset-db test-go test-ts test seed explain fmt db-status db-up db-down db-reset db-create

## Bring up all services (Postgres, Redis, Go + TS services, dashboard)
up:
	docker compose up --build

## Bring up in the background
up-d:
	docker compose up --build -d

## Stop and remove all containers
down:
	docker compose down

## Tail logs from every service
logs:
	docker compose logs -f

## Apply database migrations (alias for db-up)
migrate: db-up

## Nuke Postgres volume and re-apply from scratch (alias for db-reset)
reset-db: db-reset

## Run the Go policy test suite
test-go:
	cd services/decision-engine && go test ./... -v

## Run the TypeScript test suite
test-ts:
	cd services/execution && npm test

## Run all tests
test: test-go test-ts

## Generate and load the synthetic batch dataset through the running pipeline
seed:
	cd data/synthetic-batch-generator && npm run generate

## Print the full reasoning trace for a given event ID (Phase 3's --explain mode)
## Requires the decision-engine container to be up and the DB reachable on localhost.
explain:
	cd services/decision-engine && \
	DATABASE_URL="postgres://postgres:postgres@localhost:5432/revenue_recovery?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
		go run ./cmd/server --explain $(EVENT_ID)

## Format all Go and TS code
fmt:
	cd services/ingestion && go fmt ./...
	cd services/decision-engine && go fmt ./...
	cd services/execution && npx prettier --write .
	cd services/llm-orchestrator && npx prettier --write .
	cd services/dashboard && npx prettier --write .

## Goose: check migration status
db-status:
	@GOOSE_DRIVER=postgres GOOSE_DBSTRING="$(DATABASE_URL)" goose -dir=$(migrationPath) status

## Goose: apply all pending migrations
db-up:
	@GOOSE_DRIVER=postgres GOOSE_DBSTRING="$(DATABASE_URL)" goose -dir=$(migrationPath) up

## Goose: rollback last migration
db-down:
	@GOOSE_DRIVER=postgres GOOSE_DBSTRING="$(DATABASE_URL)" goose -dir=$(migrationPath) down

## Goose: rollback all migrations
db-reset:
	@GOOSE_DRIVER=postgres GOOSE_DBSTRING="$(DATABASE_URL)" goose -dir=$(migrationPath) reset

## Goose: create a new migration file
db-create:
	@read -p "Enter migration name: " name; \
	GOOSE_DRIVER=postgres GOOSE_DBSTRING="$(DATABASE_URL)" goose -dir=$(migrationPath) create $$name sql
