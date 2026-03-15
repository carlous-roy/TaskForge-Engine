# TaskForge

**Distributed report generation engine.** Submit report requests via API, workers build them asynchronously with retry logic and dead letter queues, download results from S3 — all running locally with Docker in minutes.

**[Try the Live Demo](https://taskforge.roycarlous.com)**

---

## Features

### Distributed Job Processing
- **REST API** — Submit report requests and poll for status. Returns immediately with a job ID while workers process in the background.
- **SQS Message Queue** — Jobs are queued via AWS SQS with configurable visibility timeouts. Workers independently poll for work, enabling horizontal scaling.
- **DynamoDB Persistence** — Full job lifecycle tracked with status transitions, attempt counts, timestamps, and correlation IDs.
- **S3 Report Storage** — Generated CSV files are uploaded to S3 with presigned download URLs that expire after 60 minutes.

### Fault Tolerance
- **Exponential Backoff** — Failed jobs retry with increasing delays (1s → 4s → 16s) plus 20% jitter to prevent thundering herd.
- **Dead Letter Queue** — After 3 failed attempts, jobs move to a dedicated DLQ for investigation instead of being silently dropped.
- **Idempotency Keys** — Duplicate submissions with the same key return `409 Conflict`. No duplicate reports, ever.
- **Graceful Shutdown** — Workers finish in-flight reports before stopping. SIGTERM triggers drain mode with a 60-second timeout.

### Report Generation
- **Sales Summary** — Aggregates transaction data by product, region, and date with totals, averages, and order counts.
- **Inventory Snapshot** — Current stock levels across warehouses with low-stock alerts and total valuation.
- **User Activity** — Login counts, actions per user, most common actions, and hourly activity breakdown.

### Production Engineering
- **Correlation Tracing** — Every job gets a 12-character ID at submission. It follows the job from API → SQS → Worker → S3 through every log line.
- **Rate Limiting** — 60 requests per minute per IP address. Returns `429 Too Many Requests` when exceeded.
- **Job TTL** — Reports auto-expire from DynamoDB after 24 hours. S3 presigned URLs expire after 60 minutes.
- **Input Validation** — Request payloads validated at the API layer with meaningful error messages.

### Dashboard
- **Report Submission** — Select report type, configure parameters, and submit from the browser.
- **Live Status Tracking** — Reports table auto-refreshes every 2 seconds showing real-time status transitions.
- **Service Health** — Queue depth, service status, and worker connectivity at a glance.
- **Download Links** — Completed reports show direct S3 download links for the generated CSV files.

---

## Architecture

```
┌──────────────────┐     ┌──────────────────────────────────────────────┐
│  Dashboard       │────>│  Spring Boot API (:8080)                     │
│  (embedded)      │     │                                              │
└──────────────────┘     │  POST /api/v1/reports    -> Submit job       │
                         │  GET  /api/v1/reports/id -> Status + URL     │
┌──────────────────┐     │  GET  /api/v1/reports    -> List all         │
│  Any HTTP Client │────>│  GET  /api/v1/health     -> Service health   │
│  (curl, etc)     │     └──────────┬──────────┬───────────────────────┘
└──────────────────┘                │          │
                              ┌─────▼───┐  ┌───▼───────┐
                              │ DynamoDB │  │    SQS    │
                              └─────────┘  └─────┬─────┘
                                                 │
                         ┌───────────────────────▼─────────────────────┐
                         │  Spring Boot Worker (:8081)                  │
                         │                                              │
                         │  Poll SQS -> Query H2 -> Generate CSV       │
                         │  Upload S3 -> Update DynamoDB                │
                         └──────────┬──────────┬───────────────────────┘
                              ┌─────▼───┐  ┌───▼───┐
                              │   H2    │  │  S3   │
                              │  (data) │  │(files)│
                              └─────────┘  └───────┘
```

---

## Quick Start

### Prerequisites

- Java 17+ ([install via Homebrew](https://formulae.brew.sh/formula/openjdk@17): `brew install openjdk@17`)
- [Docker](https://docs.docker.com/get-docker/) (for LocalStack)

### 1. Clone the repository

```bash
git clone https://github.com/carlous-roy/TaskForge-Engine.git
cd TaskForge-Engine
```

### 2. Start LocalStack

```bash
docker run -d --name taskforge-localstack \
  -p 4566:4566 \
  -e SERVICES=dynamodb,sqs,s3 \
  localstack/localstack:3.1
```

### 3. Build the project

```bash
./mvnw clean package -DskipTests
```

### 4. Start the API

```bash
java -jar taskforge-api/target/taskforge-api-1.0.0.jar
```

### 5. Start a Worker (new terminal)

```bash
WORKER_ID=worker-1 java -jar taskforge-worker/target/taskforge-worker-1.0.0.jar
```

### 6. Open the dashboard

Visit **http://localhost:8080** — select a report type, configure parameters, and click Generate Report.

### 7. Verify via CLI

```bash
./scripts/test-api.sh
```

This submits all 3 report types, tests idempotency, waits for processing, and checks download URLs.

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/reports` | POST | Submit a report request |
| `/api/v1/reports/{id}` | GET | Get report status and metadata |
| `/api/v1/reports/{id}/download` | GET | Redirect to S3 presigned download URL |
| `/api/v1/reports` | GET | List reports (filter: `?status=COMPLETED`) |
| `/api/v1/health` | GET | Service health check with queue depth |

---

## Project Structure

```
TaskForge-Engine/
├── taskforge-common/          # Shared models, AWS clients, services
│   └── com.taskforge.common
│       ├── config/                # AwsConfig (DynamoDB, SQS, S3), JacksonConfig
│       ├── dto/                   # CreateReportRequest, ReportResponse, ErrorResponse
│       ├── enums/                 # ReportType, ReportStatus
│       ├── exception/             # ReportNotFound, Duplicate, GenerationException
│       ├── model/                 # ReportJob (lifecycle, backoff calculation)
│       ├── repository/            # ReportJobRepository (DynamoDB with GSI + TTL)
│       └── service/               # QueueService (SQS), StorageService (S3)
├── taskforge-api/             # REST API (port 8080)
│   └── com.taskforge.api
│       ├── config/                # RateLimitFilter (60 req/min per IP)
│       ├── controller/            # ReportController, GlobalExceptionHandler
│       ├── service/               # ReportService (submit, status, download)
│       └── resources/static/      # Embedded React dashboard
├── taskforge-worker/          # Report processor (port 8081)
│   └── com.taskforge.worker
│       ├── config/                # HealthEndpoint
│       ├── data/                  # DataSeeder (H2 sample business data)
│       ├── report/                # ReportGenerator + 3 implementations
│       └── service/               # JobProcessor, MessagePoller (graceful shutdown)
├── scripts/test-api.sh        # Automated API smoke tests
├── docker-compose.yml         # Full stack (LocalStack + API + Worker)
├── README.md
└── LICENSE
```

---

## Configuration

All settings are controlled via environment variables. Defaults work for local development with LocalStack.

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_ENDPOINT` | `http://localhost:4566` | LocalStack endpoint. Remove for real AWS. |
| `AWS_ACCESS_KEY` | `changeme` | AWS access key |
| `AWS_SECRET_KEY` | `changeme` | AWS secret key |
| `WORKER_ID` | `worker-1` | Unique worker identifier |
| `SERVER_PORT` | `8081` | Worker HTTP port |

---

## Scaling

Start additional workers on different ports:

```bash
WORKER_ID=worker-2 SERVER_PORT=8082 java -jar taskforge-worker/target/taskforge-worker-1.0.0.jar
```

Each worker independently polls SQS. Visibility timeout ensures no two workers process the same job.

---

## Running Tests

```bash
./mvnw test
```

Unit tests cover job lifecycle, retry logic, and backoff calculation.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Java 17, Spring Boot 3.2, Maven |
| Queue | AWS SQS with dead letter queue |
| Persistence | AWS DynamoDB with GSI and TTL |
| Storage | AWS S3 with presigned URLs |
| Data Source | H2 embedded database (sample business data) |
| Local AWS | LocalStack 3.1 |
| Dashboard | React 18 (embedded, served from Spring Boot) |
| Infrastructure | Docker Compose |

---

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Roy Carlous Christudass](https://roycarlous.com) | [Live Demo](https://taskforge.roycarlous.com)
