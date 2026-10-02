# Build context is the repository root (see docker-compose.yml). Both stages are pinned by digest.
# maven:3.9.11-eclipse-temurin-17
FROM maven:3.9.11-eclipse-temurin-17@sha256:e4a7ace3dc0d645ed97f8d9ad0b0d3f0b14fa8d150138f27f116d7105a639b82 AS build
WORKDIR /build

# 1. Dependency layer: only the POMs, so Maven's downloads are cached until a POM changes.
COPY pom.xml ./
COPY taskforge-common/pom.xml taskforge-common/
COPY taskforge-test-support/pom.xml taskforge-test-support/
COPY taskforge-dashboard/pom.xml taskforge-dashboard/
COPY taskforge-api/pom.xml taskforge-api/
COPY taskforge-worker/pom.xml taskforge-worker/
RUN mvn -B -q --no-transfer-progress -pl taskforge-api -am -Ddashboard.skip=true dependency:go-offline

# 2. Node and npm packages for the dashboard, cached until package.json or the lock file changes.
COPY taskforge-dashboard/package.json taskforge-dashboard/package-lock.json taskforge-dashboard/
RUN mvn -B -q --no-transfer-progress -pl taskforge-dashboard \
    frontend:install-node-and-npm@install-node-and-npm frontend:npm@npm-ci

# 3. Sources. Tests run in CI, not in the image build, so test sources are neither compiled nor run.
COPY taskforge-common/src taskforge-common/src
COPY taskforge-dashboard/vite.config.js taskforge-dashboard/index.html taskforge-dashboard/
COPY taskforge-dashboard/public taskforge-dashboard/public
COPY taskforge-dashboard/src taskforge-dashboard/src
COPY taskforge-api/src taskforge-api/src
RUN mvn -B -q -o --no-transfer-progress -pl taskforge-api -am package -Dmaven.test.skip=true -DskipTests

# eclipse-temurin:17.0.20_8-jre-alpine
FROM eclipse-temurin:17.0.20_8-jre-alpine@sha256:45d19def67191d1df7d233282051ac2f6908c6b2d7eaef75441d7e7c721c6d01
RUN addgroup -S taskforge && adduser -S -G taskforge -h /app taskforge
WORKDIR /app
COPY --from=build --chown=taskforge:taskforge /build/taskforge-api/target/taskforge-api.jar app.jar
USER taskforge
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/actuator/health || exit 1
# Exec form: java is PID 1 and receives SIGTERM directly, which starts Spring's graceful shutdown.
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "app.jar"]
