FROM alpine:latest
RUN apk add --no-cache ca-certificates
ADD proximity-chat /usr/local/bin
ADD /web /web/
EXPOSE 8000
CMD proximity-chat