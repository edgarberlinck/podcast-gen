HOST_UID := $(shell id -u)
HOST_GID := $(shell id -g)
export HOST_UID HOST_GID

.PHONY: ensure-env up down logs

ensure-env:
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example; add your local credentials there."; fi

up: ensure-env
	mkdir -p data
	docker compose up --build -d

down: ensure-env
	docker compose down

logs:
	docker compose logs -f studio
