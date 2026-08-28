FROM alpine:3.20

RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY server .
RUN chmod +x ./server

EXPOSE 8080
CMD ["./server"]
