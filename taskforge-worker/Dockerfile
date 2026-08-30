# Multi-stage: build context is the repository root (see docker-compose.yml), so the image
# compiles from source and needs no local Maven build first.
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build

# Module poms first: the reactor needs every module declared in the parent pom to resolve,
# and this layer caches until a pom actually changes.
COPY pom.xml ./
COPY taskforge-common/pom.xml taskforge-common/
COPY taskforge-api/pom.xml taskforge-api/
COPY taskforge-worker/pom.xml taskforge-worker/

COPY taskforge-common/src taskforge-common/src
COPY taskforge-worker/src taskforge-worker/src

RUN mvn -B -pl taskforge-worker -am clean package -DskipTests

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /build/taskforge-worker/target/taskforge-worker-1.0.0.jar app.jar
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "app.jar"]
