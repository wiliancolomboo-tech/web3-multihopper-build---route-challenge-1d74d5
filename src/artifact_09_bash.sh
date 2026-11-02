# Launch multi-hop optimizer and telemetry pipeline
docker-compose up -d --build

# Verify health endpoint
curl -i http://localhost:8080/healthz