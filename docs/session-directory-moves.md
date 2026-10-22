# Moving a session to another directory

In the web interface, open **Session controls**, enter an existing destination
directory on the server, and select **Change directory**. A session started in a
home directory can be moved into a newly created project directory when planning
is complete.

The destination does not need to be a Git repository, have an `origin` remote,
or share an origin with the source. An unregistered destination is resolved using
normal project discovery. The session adopts that project's identity; non-Git
directories use the existing global-project convention. A destination already
registered to the current project retains that explicit association.

The session ID, conversation, and title are preserved. No source or destination
files are copied, moved, applied, or discarded. Project creation when needed,
project ownership, destination-root registration, exact directory placement,
and the selected session's cached-context reset commit atomically. Existing
destination-project metadata is preserved. Durable move replay restores the same
ownership and placement; older moves without a destination project retain their
original ownership.

The session must be idle with no pending prompts, permissions, questions, or
active descendant work. The destination must exist and be accessible as a
directory to the server, including when the server runs in a container. Refusals
leave the session unchanged, and the web dialog displays the server's specific
reason. After a stale-source refusal, reopen session controls to refresh the
session's current directory before retrying.

This changes the explicit selected-session directory control. The separate
legacy move-with-file-changes operation retains its existing project constraint.
