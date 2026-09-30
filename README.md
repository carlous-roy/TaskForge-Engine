# TaskForge

<p>
  <a href="https://github.com/carlous-roy/TaskForge-Engine/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-GitHub_Actions-2088FF?style=flat-square&logo=githubactions&logoColor=white" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Java-17-007396?style=flat-square&logo=openjdk&logoColor=white" alt="Java 17" />
  <img src="https://img.shields.io/badge/Spring_Boot-4.1-6DB33F?style=flat-square&logo=springboot&logoColor=white" alt="Spring Boot 4.1" />
  <img src="https://img.shields.io/badge/AWS-SQS_%C2%B7_DynamoDB_%C2%B7_S3-FF9900?style=flat-square&logo=amazonwebservices&logoColor=white" alt="AWS" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
</p>

A job-processing system for CSV reports, built on Spring Boot with SQS, DynamoDB and S3.

You POST a report request. The API writes a job record, puts a message on an SQS queue and answers
`202 Accepted` with the job id. Independent workers receive the message, run a query against a
seeded sample dataset in an embedded H2 database, upload the CSV to S3 and record the outcome. You
poll the job, or watch the embedded dashboard, and when it is `COMPLETED` you get a presigned S3 URL
that is valid for 60 minutes.

Most of the code is about what happens when a step fails. The behaviour below is what the code does,
and each point has a test.

- **Retries with full-jitter backoff, driven by SQS.** A failed attempt does not re-send the message.
  The worker hides the same message with `ChangeMessageVisibility` for `random(0, min(60 s, 2 s × 2^attempt))`
  seconds and SQS redelivers it. Three attempts in total.
- **A real dead-letter queue.** The queue's redrive policy moves a message to the dead-letter queue
  after its third delivery. A consumer in the worker reads that queue, marks the job `FAILED` with
  the last recorded error, stamps `deadLetteredAt`, and stops.
- **Idempotency keys enforced by a conditional transaction.** The job and a `KEY#<key>` marker are
  written in one DynamoDB `TransactWriteItems`, each conditional on not existing. Concurrent
  duplicates lose the transaction and get `409 Conflict` with the existing job id.
- **Conditional state transitions.** Every write to a job is conditional on a version attribute. A
  slow worker cannot overwrite a job another worker has completed.
- **A drain on SIGTERM.** The worker stops polling, finishes in-flight jobs for up to 60 seconds,
  then interrupts what is left; an interrupted job hands its message straight back to SQS.
- **Correlation ids on every hop.** The API accepts or generates `X-Correlation-ID`, every log line
  in both processes carries it, it travels as an SQS message attribute, and the S3 object is tagged
  with it.
- **Rate limiting that survives a proxy.** 60 requests per minute per client address, with
  `X-Forwarded-For` honoured only from a configured list of proxies.

[Browser walkthrough](https://taskforge.roycarlous.com) · [Portfolio](https://roycarlous.com)

The walkthrough at taskforge.roycarlous.com is a static page that animates the job state machine
in the browser. It does not call this API and produces no real reports; to see the system run, start
it locally as described below.

---

## How a job moves

```
ACCEPTED ──> QUEUED ──> PROCESSING ──> COMPLETED
                           │   ▲
                           ▼   │ (SQS redelivers after the backoff)
                     RETRY_SCHEDULED
                           │
                           ▼
                         FAILED   (non-retryable error, or third attempt failed and the message
                                   went to the dead-letter queue)
```

1. `POST /api/v1/reports` validates the body and the parameters for the report type. Any problem
   is a `400` that lists every issue.
2. The API writes the job as `ACCEPTED` (with its idempotency-key marker, transactionally), sends
   the SQS message, then moves the job to `QUEUED`. If the send fails, the record and the marker are
   deleted again so the key is not burned, and the client gets `503` with `Retry-After`.
3. A worker receives the message, loads the job and moves it to `PROCESSING` under its own name
   (conditional on the version it read). If another worker holds the job and touched it within the
   visibility timeout, the delivery is skipped. If the holder has gone silent for longer than that,
   the job is taken over.
4. The generator builds the CSV, the worker uploads it (tagged with the correlation id), moves the
   job to `COMPLETED` and deletes the message.
5. On failure the worker classifies the error. Bad parameters, parse errors, SQL errors that are bugs
   and 4xx responses from AWS are permanent: the job is `FAILED` at once and the message deleted.
   Timeouts, throttling, 5xx responses and connection failures are transient: the job becomes
   `RETRY_SCHEDULED` with `nextAttemptAt`, and the message is hidden for the backoff.
6. When the third delivery fails, the job is marked `FAILED` and the message is released immediately;
   the next receive makes SQS move it to the dead-letter queue, where the worker's dead-letter
   consumer records `deadLetteredAt` and acknowledges it. A message also reaches the dead-letter
   queue when a worker dies holding it three times; then the consumer is what marks the job `FAILED`.

### Backoff

The delay before a retry is drawn uniformly from `[0, min(cap, base × 2^attempt)]` whole seconds,
with `base = 2 s` and `cap = 60 s`: after the first failure `0–4 s`, after the second `0–8 s`. This is
the "full jitter" strategy from Marc Brooker's post "Exponential Backoff And Jitter" on the AWS
Architecture Blog (March 2015, https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
The point of the randomness is that a batch of jobs failing against the same overloaded dependency
does not come back all at once. `BackoffPolicyTest` checks the bounds and that repeated draws differ;
`JobProcessorTest` checks that the visibility timeout actually sent to SQS varies.

### Idempotency

DynamoDB has one table. Job records use their UUID as the key; idempotency markers use
`KEY#<idempotencyKey>` and point at the job id. A submission with a key writes both in one
`TransactWriteItems`, each with `ConditionExpression attribute_not_exists(id)`. Two submissions with
the same key cannot both succeed, whatever their timing; the loser reads the marker and answers
`409 Conflict` with `existingReportId` and a `Location` header. `ReportJobRepositoryIT` runs twenty
concurrent creates with one key and asserts one job; `SubmissionIT` does the same over HTTP.

---

## Running it

### Prerequisites

- Java 17 or newer and Docker, or
- Java 17 or newer and Python 3 with `moto[server]`, if you cannot run Docker.

### With Docker Compose

```bash
docker compose up --build
```

This starts LocalStack, the API on http://localhost:8080 (the dashboard is at `/`) and one worker on
port 8081. The images build the code inside Docker, so no local Maven or Node is needed. Presigned
download links point at `http://localhost:4566`, which is LocalStack's published port.

### Without Docker

Start an emulator on port 4566, for example moto:

```bash
pip install "moto[server]"
moto_server -H 127.0.0.1 -p 4566
```

Build and run:

```bash
./mvnw -B package -DskipTests -DskipITs
java -jar taskforge-api/target/taskforge-api.jar
WORKER_ID=worker-1 java -jar taskforge-worker/target/taskforge-worker.jar
```

The default Spring profile is `local`, which points every AWS client at `http://localhost:4566` with
placeholder credentials. Both processes create the table, the two queues and the bucket if they are
missing.

### Check it end to end

```bash
./scripts/test-api.sh
```

The script submits a report, repeats the submission to get a `409`, sends invalid input to get
`400`s, waits for the worker, follows the `302` to the presigned URL and downloads the CSV. It exits
non-zero on the first unexpected response.

### Against AWS

Run with `SPRING_PROFILES_ACTIVE=aws`. No endpoint override is set and credentials come from the
SDK's default provider chain (environment, profile, instance or task role). The processes still
create their own table, queues and bucket at startup, so the identity needs those permissions as
well as the read and write ones. This project has so far only been run against emulators.

---

## API

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/reports` | `202` with the job; `400` invalid input; `409` duplicate key; `503` queue unavailable |
| `GET` | `/api/v1/reports/{id}` | `200` with the job and, once completed, `downloadUrl`; `404` unknown |
| `GET` | `/api/v1/reports/{id}/download` | `302` to a presigned S3 URL; `409` not ready; `404` unknown or file expired |
| `GET` | `/api/v1/reports?status=COMPLETED&limit=100` | Newest jobs first, with `downloadUrl` on completed ones |
| `GET` | `/api/v1/health` | `status`, `queueDepth`, `deadLetterDepth`; `503` and `DEGRADED` when SQS cannot be reached |

Submission body:

```json
{
  "type": "SALES_SUMMARY",
  "parameters": { "dateFrom": "2026-08-19", "dateTo": "2026-09-18", "region": "North" },
  "idempotencyKey": "order-2026-09-18-01"
}
```

Parameters are checked per type at submission: `SALES_SUMMARY` takes `dateFrom`, `dateTo`
(ISO dates, from ≤ to) and `region`; `INVENTORY_SNAPSHOT` takes `warehouse` and `lowStockThreshold`
(0–1,000,000); `USER_ACTIVITY` takes `dateFrom`, `dateTo` and `userId` (positive integer). Unknown
parameter names are rejected. The idempotency key is 1–128 characters of `A-Z a-z 0-9 . _ : -`.

Every error has the same body:

```json
{
  "timestamp": "2026-09-18T17:04:29Z",
  "status": 400,
  "error": "Bad Request",
  "message": "Invalid report parameters",
  "details": ["parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'nope'"],
  "path": "/api/v1/reports",
  "correlationId": "67f6f365fda2",
  "existingReportId": "..."
}
```

`existingReportId` appears only on a `409` for a duplicate key. Malformed JSON, unknown fields, bad
enum values, unsupported media types and methods, unknown routes and out-of-range query parameters
are all `4xx` with a message that says what to fix. Responses to `/api/**` carry `X-RateLimit-Limit`
and `X-RateLimit-Remaining`; a `429` carries `Retry-After`. Every response carries `X-Correlation-ID`.

---

## The dashboard

The API serves a React dashboard at `/`, built with Vite in the `taskforge-dashboard` module and
packaged into the API jar. It polls the report list and the health endpoint every five seconds. A
failed refresh keeps the last list on screen and shows why; a `429` pauses polling for the period the
API asks for. Completed rows link to the presigned CSV. Health shows what the API reports: `UP`,
`DEGRADED` or `UNREACHABLE`, with queue and dead-letter depths. The health endpoint is exempt from
rate limiting, and the list poll uses a fifth of the per-client budget.

---

## Reports and data

The worker seeds an in-memory H2 database at startup with a sample dataset generated from a fixed
random seed: 20 products, 800 transactions over the 90 days before startup, stock for 4 warehouses,
25 users and 500 activity records over the previous 30 days. It is not real business data. Three
generators produce CSV (UTF-8, CRLF, RFC 4180 quoting) from it:

- `SALES_SUMMARY`: quantity, revenue, average price and order count per product and region in a
  date range, then a summary line over the same rows.
- `INVENTORY_SNAPSHOT`: stock and value per product and warehouse with a low-stock flag, then a
  summary line over the same rows.
- `USER_ACTIVITY`: per-user counts in a date range, then an hourly breakdown of the same rows.

The filters apply to the summary sections as well as the rows.

---

## Configuration

Settings live in `application.yml` under `taskforge.*` and `aws.*` and are bound to validated
`@ConfigurationProperties`. The ones with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SPRING_PROFILES_ACTIVE` | `local` | `local` uses an emulator; `aws` uses AWS itself |
| `AWS_ENDPOINT` | `http://localhost:4566` (local profile) | Emulator endpoint for every client |
| `AWS_PUBLIC_ENDPOINT` | same as `AWS_ENDPOINT` | Endpoint written into presigned URLs |
| `AWS_REGION` | `us-east-1` | Region |
| `AWS_ACCESS_KEY`, `AWS_SECRET_KEY` | `test` | Static credentials, used only with an emulator |
| `TASKFORGE_TRUSTED_PROXIES` | empty | Regular expression of proxy addresses whose `X-Forwarded-For` is trusted |
| `TASKFORGE_RATE_LIMIT_PER_MINUTE` | `60` | Requests per minute per client address |
| `TASKFORGE_RATE_LIMIT_ENABLED` | `true` | |
| `TASKFORGE_WORKER_MAX_CONCURRENT` | `3` | Jobs one worker runs at a time |
| `TASKFORGE_WORKER_DRAIN_TIMEOUT` | `60s` | How long a stopping worker waits for in-flight jobs |
| `WORKER_ID` | host name plus a suffix | Name written into `lockedBy` and logs |
| `SERVER_PORT` | `8081` | Worker HTTP port |

Other settings, changed in the YAML: `taskforge.retry.max-attempts` (3; also the redrive policy's
`maxReceiveCount`), `taskforge.retry.backoff.base` (2 s) and `cap` (60 s), `taskforge.sqs.visibility-timeout`
(120 s; must exceed the longest report), `taskforge.dynamodb.job-ttl` (24 h), `taskforge.s3.download-expiry`
(60 min) and `taskforge.s3.object-expiry-days` (1, applied as a bucket lifecycle rule).

---

## Tests

```bash
./mvnw -B verify              # unit tests, dashboard tests, integration tests
./mvnw -B verify -DskipITs    # unit tests only
```

Unit tests cover the state machine, the backoff, the parameter rules, the API's status codes and
error bodies, the rate limiter, the proxy-header handling on a real Tomcat, the worker's outcomes
(success, retry, last attempt, permanent failure, interruption, stale lock, takeover), the
dead-letter consumer, the generators over the seeded data, and the drain (in-flight work completes;
the deadline interrupts what is left).

Integration tests (`*IT`, run by failsafe) exercise the real DynamoDB, SQS and S3 code:
the repository (including twenty concurrent creates with one key), the queue (redelivery after
`ChangeMessageVisibility`, redrive to the dead-letter queue), storage (tags, lifecycle, a presigned
URL that downloads), the API over HTTP with a burst of duplicate submissions, and the whole worker
with an injected failing generator (retry, retry, fail, dead-letter). They start LocalStack through
Testcontainers, which is what CI does; without Docker, set `AWS_ENDPOINT_OVERRIDE` to a running
emulator, for example `AWS_ENDPOINT_OVERRIDE=http://127.0.0.1:4566 ./mvnw -B verify` with
`moto_server` on that port. The LocalStack image is pinned to 4.14.0 by digest: it is the last
release that starts without an account token, and the tests must run on any machine without one.

One test needs the real thing: the twenty concurrent creates assert that exactly one wins the key,
which holds on DynamoDB and on DynamoDB Local inside LocalStack because they apply transactions one
at a time. moto applies a transaction's items without a lock, so on moto that test skips itself
(set `AWS_EMULATOR_SERIALIZES_TRANSACTIONS=true` if the emulator behind your override does
serialise them). The `TransactionConflict` cancellation that DynamoDB returns to the losing side of
such a race is covered by unit tests with a stubbed client, since no emulator produces it on demand.

---

## Layout

```
taskforge-common/        job model, DynamoDB repository, SQS and S3 services, backoff, parameter rules
taskforge-api/           REST API, error mapping, rate limiter, correlation filter
taskforge-worker/        poller, job processor, dead-letter consumer, generators, data seeder
taskforge-dashboard/     React dashboard (Vite), packaged as static resources for the API
taskforge-test-support/  locates the AWS emulator for integration tests
scripts/test-api.sh      end-to-end check against a running stack
.github/workflows/ci.yml mvnw verify and docker compose build on pushes to main and pull requests
```

---

## Limits

- Rate limiting is per API instance and in memory. Two instances give a client twice the budget.
- There is no authentication. Anyone who can reach the API can submit jobs and read every job and
  its download link. Put it behind something before exposing it.
- A job that runs longer than the SQS visibility timeout (120 s) will be redelivered while it is
  still running; the second worker will see a stale lock and take it over, and the first worker's
  result is discarded when its conditional write fails. Raise the timeout for slow reports.
- The dashboard's list request reads the whole table (every page of the scan) and sorts in memory.
  With the 24-hour TTL the table stays small; it would not scale to millions of jobs.
- The services create their own table, queues and bucket. That is convenient locally and means the
  AWS identity needs create permissions.

## License

MIT
