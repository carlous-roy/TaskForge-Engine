# TaskForge

<p>
  <a href="https://taskforge.roycarlous.com"><img src="https://img.shields.io/badge/Live_demo-taskforge.roycarlous.com-22C55E?style=flat-square" alt="Live demo" /></a>
  <img src="https://img.shields.io/badge/Java-17-007396?style=flat-square&logo=openjdk&logoColor=white" alt="Java 17" />
  <img src="https://img.shields.io/badge/Spring_Boot-6DB33F?style=flat-square&logo=springboot&logoColor=white" alt="Spring Boot" />
  <img src="https://img.shields.io/badge/AWS-SQS_%C2%B7_S3_%C2%B7_DynamoDB-FF9900?style=flat-square&logo=amazonwebservices&logoColor=white" alt="AWS" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
</p>

A distributed report generation engine.

You POST a report request. The API hands back a job ID immediately and pushes the job onto SQS.
Independent workers poll the queue, query the data, build a CSV, upload it to S3, and update job
state. You poll for status and eventually get a presigned download URL. Nothing blocks, and no
single worker going down loses your job.

The happy path is short. Most of the code here exists to handle the specific ways it fails:

- A downstream service is briefly overloaded, so retries need **exponential backoff with jitter**
  (1s, 4s, 16s, plus 20% randomness) rather than a synchronized retry storm.
- A job is genuinely poisonous and will never succeed, so after three attempts it goes to a
  **dead-letter queue** instead of cycling forever or vanishing.
- A client's network hiccups and it submits the same request twice, so **idempotency keys** return
  `409 Conflict` rather than generating the report twice and billing for both.
- A deploy rolls the workers mid-job, so **SIGTERM triggers a drain**: stop accepting, finish what's
  in flight, 60-second timeout, then exit.
- Something failed at 3am and you need to know where, so a **12-character correlation ID** assigned
  at submission follows the job through API to SQS to worker to S3, in every log line.

[Live demo](https://taskforge.roycarlous.com) · [Portfolio](https://roycarlous.com)

---

## Features

### Distributed Job Processing
- **REST API**: submit report requests and poll for status. Returns immediately with a job ID while workers process in the background.
- **SQS Message Queue**: jobs are queued via AWS SQS with configurable visibility timeouts. Workers independently poll for work, enabling horizontal scaling.
- **DynamoDB Persistence**: full job lifecycle tracked with status transitions, attempt counts, timestamps, and correlation IDs.
- **S3 Report Storage**: generated CSV files are uploaded to S3 with presigned download URLs that expire after 60 minutes.

### Fault Tolerance
- **Exponential Backoff**: failed jobs retry with increasing delays (1s → 4s → 16s) plus 20% jitter to prevent thundering herd.
- **Dead Letter Queue**: after 3 failed attempts, jobs move to a dedicated DLQ for investigation instead of being silently dropped.
- **Idempotency Keys**: duplicate submissions with the same key return `409 Conflict`. No duplicate reports, ever.
- **Graceful Shutdown**: workers finish in-flight reports before stopping. SIGTERM triggers drain mode with a 60-second timeout.

### Report Generation
- **Sales Summary**: aggregates transaction data by product, region, and date with totals, averages, and order counts.
- **Inventory Snapshot**: current stock levels across warehouses with low-stock alerts and total valuation.
- **User Activity**: login counts, actions per user, most common actions, and hourly activity breakdown.

### Production Engineering
- **Correlation Tracing**: every job gets a 12-character ID at submission. It follows the job from API → SQS → Worker → S3 through every log line.
- **Rate Limiting**: 60 requests per minute per IP address. Returns `429 Too Many Requests` when exceeded.
- **Job TTL**: reports auto-expire from DynamoDB after 24 hours. S3 presigned URLs expire after 60 minutes.
- **Input Validation**: request payloads validated at the API layer with meaningful error messages.

### Dashboard
- **Report Submission**: select report type, configure parameters, and submit from the browser.
- **Live Status Tracking**: reports table auto-refreshes every 2 seconds showing real-time status transitions.
- **Service Health**: queue depth, service status, and worker connectivity at a glance.
- **Download Links**: completed reports show direct S3 download links for the generated CSV files.

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

Visit **http://localhost:8080**, select a report type, configure parameters, and click Generate Report.

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

## What I'd do differently

- **The report generators query H2 in-process.** That was the right call for a demo that has to run
  from `docker compose up` with no external database, but it means the worker owns both the queue
  loop and the data access. In a real deployment those are separate concerns and the data layer
  belongs behind its own service boundary.
- **Retry policy is fixed at three attempts for everything.** A transient S3 timeout and a malformed
  report request deserve different treatment: the first should retry aggressively, the second should
  go straight to the DLQ. Classifying failures before retrying them would cut DLQ noise a lot.
- **There is no backpressure.** The API accepts submissions as fast as clients send them, regardless
  of queue depth. Under sustained load that pushes the problem into SQS rather than solving it. A
  depth check that returns 503 above a threshold would be honest about capacity.
- **Rate limiting is per-IP and in-memory**, so it resets on deploy and does not survive horizontal
  scaling. Fine for a demo, wrong for anything real.

## License

MIT
