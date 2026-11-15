# Record images in tables

Status: Deferred. This spec records the smaller design for future work.

## Behavior

A workspace admin can open an object's Links field in Schema and choose **Use as
record image**. The choice is shared by everyone in the workspace and applies
to that object only. For example, Company can use its **Domain** field and a
custom Organization can use **Website**. The selected field offers **Clear
record image**. Each object starts with no image source.

The table shows the image beside the record name in the existing avatar slot.
The image comes from the selected field's primary website link. Hiding or
moving that column has no effect. Editing the primary link updates the image.
Use the existing initials or object icon if the link is missing or invalid,
or if the image fails to load.

## Implementation

- Store an optional reference to the field's stable ID in object metadata.
  Apply the change through the schema engine and require a workspace admin.
  The source must be an active Links field on the same object. Renaming the
  field preserves the binding. Deleting the field clears it.
- Use the existing Links field panel for the setting. Selecting a source
  enables lookups for that object. Tell the admin that website hostnames are
  sent to Twenty Icons. Clearing the source turns off its lookups.
- The browser requests the image from the fixed `https://twenty-icons.com/`
  origin using only the normalized public website hostname. Use a no-referrer
  image request and load it lazily. With no source configured, the table makes
  no image requests.

The scope is Schema configuration and table rendering. MCP configuration, a
workspace-wide toggle, automatic Company setup, images on sheets and full
pages, uploads, and in-house extraction are deferred.

## Acceptance

- An admin configures Website for a custom Organization. A second browser
  in the same workspace shows the same avatar. Other objects and workspaces
  keep their own settings.
- The avatar stays visible when the Website column is hidden or the field is
  renamed. Editing the primary URL changes the requested hostname.
- An invalid link or missing image shows the existing avatar. Clearing the
  setting or deleting the field stops lookups for that object.
- A non-admin cannot change the image source.
