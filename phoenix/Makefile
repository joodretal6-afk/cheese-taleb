# Project Phoenix — convenience targets.
COMPOSE = docker compose -f infra/docker-compose.yml

.PHONY: up down logs test editor admin

up:        ## Start the whole backend stack
	$(COMPOSE) up --build

down:      ## Stop the stack
	$(COMPOSE) down

logs:      ## Tail service logs
	$(COMPOSE) logs -f

test:      ## Run every service's unit tests
	cd services/auth && npm test
	cd services/profile && npm test
	cd services/inventory && npm test
	cd services/matchmaking && npm test

editor:    ## Run the Map Editor (web)
	cd editor && npm run dev

admin:     ## Run the Admin Dashboard (web)
	cd admin && npm run dev
