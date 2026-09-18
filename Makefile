.PHONY: up smoke logs down test

up:
	./scripts/up.sh

smoke:
	./scripts/smoke.sh

logs:
	kubectl --context kind-calling-agent --namespace calling-agent logs deployment/calling-agent --follow

down:
	./scripts/down.sh

test:
	npm test
