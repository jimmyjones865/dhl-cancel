# DHL Cancel

A tiny self-hosted service to cancel already-printed DHL shipments by scanning
their barcode. Single page, Nord theme, no auth, no client-side config.

## Quick start

```bash
cp .env.example .env
# edit .env and fill in DHL_* credentials
docker compose up -d --build
```

Then open `http://<host>:8080` on the scanner PC. Click anywhere on the page
once to give it focus, then scan. The page POSTs the scanned shipment number
to `/cancel`, calls the DHL API and shows:

- **OK** (green) when the shipment was cancelled
- **Error** (red) with a human-readable message otherwise

The page focuses the input automatically and after every scan, so you can keep
scanning labels without touching the keyboard or mouse.

## Configuration

All configuration lives in `.env` and is read by the container at startup.
Nothing is stored client-side — restarting the client PC has no effect.

| Variable        | Required | Default                  | Notes                                                                 |
|-----------------|----------|--------------------------|-----------------------------------------------------------------------|
| `DHL_ENV`       | yes      | —                        | `eu` for production, `sandbox` for testing                            |
| `DHL_USER`      | yes      | —                        | DHL Geschäftskundenportal username                                    |
| `DHL_PASSWORD`  | yes      | —                        | DHL Geschäftskundenportal password                                    |
| `DHL_API_KEY`   | yes      | —                        | App `client_id` from developer.dhl.com                                |
| `DHL_API_SECRET`| yes      | —                        | App `client_secret` from developer.dhl.com                            |
| `DHL_PROFILE`   | no       | `STANDARD_GRUPPENPROFIL` | Shipping profile                                                      |
| `PORT`          | no       | `8080`                   | Port inside the container                                             |

If any required variable is missing the container exits immediately with a
clear log message.

## Network

The service has no authentication. Keep it on your internal network — for
example by binding to a private interface in `docker-compose.yml`:

```yaml
ports:
  - "10.0.0.5:8080:8080"
```

## Endpoints

- `GET  /`         — scanner page
- `POST /cancel`   — body `{ "shipment": "00340..." }`, returns `{ ok: true }` or `{ ok: false, message: "..." }`
- `GET  /healthz`  — `200 ok` for the Docker healthcheck

Favicon: Fontawesome
