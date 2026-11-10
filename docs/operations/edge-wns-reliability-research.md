# Edge WNS receiver: recovery investigation

Status: research only. The Edge intake and worker must remain disabled in production until the setup flow, version handling, operational review and release checks are complete.

## Test scope

On Windows, a disposable Edge profile subscribed to a localhost test site. No existing browser profile, X account or X notification was used. The browser's generated subscription was transferred to a synthetic receiver; a second subscription and the receiver used the real Windows notification service. The receiver reconnected with its rotated token. No public service credentials or subscription keys were logged or retained.

Two independent test profiles were compared. Each received one test notification while connected, disconnected, received another test notification while offline, and reconnected. The first receiver closed without writing an acknowledgement for the connected notification. The second wrote the current candidate acknowledgement and waited briefly before closing. After reconnect, each was observed for 30 seconds before a new notification was sent.

## Observations and limits

- Both runs received the notification sent while disconnected and a fresh notification after the observation period.
- Neither run replayed the notification that had already arrived before disconnection during the 30-second observation period, including the run that did not send an acknowledgement.
- Writing the candidate acknowledgement did not prevent the next notification from arriving. This does not prove that WNS durably accepted the acknowledgement.
- These are two controlled observations, not a complete specification of WNS replay, browser Web Push behavior, long outages or production delivery. The experiment does not prove that a notification lost before the database commit can be recovered.
- The implementation persists an owned encrypted notification before writing an acknowledgement and recovers a committed notification after a worker takeover. That protects already committed data; it does not establish a guarantee for a process crash before commit.
- Microsoft documents that WNS notification delivery is not guaranteed, and that a successful sender response is not proof of delivery. Its documentation also describes type-dependent offline caching; do not assume those native-app details completely describe Edge Web Push. See [WNS overview](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview) and [WNS request and response headers](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/push-request-response-headers).

## Release follow-up

Validate the final setup flow with an explicitly approved real X test, characterize reconnect and multi-notification offline behavior for supported Edge versions, and decide how to surface and mitigate provider-side delivery gaps. Keep any replay or delivery claim within the evidence gathered. Do not silently enable a polling fallback or alter the existing notification plan without an approved design.
