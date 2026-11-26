# Upgrades and backups

Before upgrading a shared self-hosted instance, record the current image version and back up Postgres. Stop writes while taking a coordinated backup if you use external file storage.

For the bundled Compose Postgres service, write a custom-format dump to a file on the host:

```sh
docker compose -f docker/compose.yml exec -T postgres \
  pg_dump -U retainer -d retainer -Fc > retainer-backup.dump
```

Adjust the service, role, and database names for your configuration. Keep the dump and the instance configuration in protected storage. If you use file storage, back up its byte volume or bucket as well. Preserve the configured secrets used for authentication, stored data, and privacy erasure.

Test restoration into a separate instance before relying on the backup. Verify that records, file downloads when configured, and a new authenticated request work there.

For upgrade ordering, migration commands, and Postgres version requirements, follow [Upgrading](../self-hosting.md#upgrading). For the relationship between Postgres metadata and file bytes, see [File storage](../files.md).
