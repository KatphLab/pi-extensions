install:
	bun install && bun run prepare

install-bin:
	bun add --global "{{justfile_directory()}}"
