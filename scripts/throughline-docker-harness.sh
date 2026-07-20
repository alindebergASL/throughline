#!/usr/bin/env bash

# Shared lifecycle primitives for disposable Throughline Docker test containers.
# Source this file from a verification harness. Historical rollout scripts are
# evidence and must not be rewritten in place to adopt this helper.

# Re-sourcing shared setup must not discard an active harness state.
_THROUGHLINE_DOCKER_HARNESS_STATE_DIR="${_THROUGHLINE_DOCKER_HARNESS_STATE_DIR:-}"

throughline_docker_cli() {
  if [[ -n "${THROUGHLINE_DOCKER_BIN:-}" ]]; then
    "${THROUGHLINE_DOCKER_BIN}" "$@"
  else
    sudo -n docker "$@"
  fi
}

throughline_docker_harness_init() {
  if [[ -n "${_THROUGHLINE_DOCKER_HARNESS_STATE_DIR:-}" ]]; then
    printf 'Throughline Docker harness is already initialized.\n' >&2
    return 1
  fi

  local state_dir raw_baseline
  state_dir="$(mktemp -d "${TMPDIR:-/tmp}/throughline-docker-harness.XXXXXX")" || return 1
  raw_baseline="$state_dir/baseline.raw"
  : >"$state_dir/containers" || {
    rmdir "$state_dir" 2>/dev/null || true
    return 1
  }

  if ! throughline_docker_cli volume ls --quiet --filter dangling=true >"$raw_baseline"; then
    rm -f "$state_dir/containers" "$raw_baseline"
    rmdir "$state_dir" 2>/dev/null || true
    printf 'Unable to snapshot the pre-run dangling Docker volumes.\n' >&2
    return 1
  fi
  if ! LC_ALL=C sort -u "$raw_baseline" >"$state_dir/baseline"; then
    rm -f "$state_dir/containers" "$raw_baseline" "$state_dir/baseline"
    rmdir "$state_dir" 2>/dev/null || true
    printf 'Unable to normalize the pre-run dangling Docker volume snapshot.\n' >&2
    return 1
  fi
  rm -f "$raw_baseline"
  _THROUGHLINE_DOCKER_HARNESS_STATE_DIR="$state_dir"
}

throughline_docker_run() {
  if [[ -z "${_THROUGHLINE_DOCKER_HARNESS_STATE_DIR:-}" ]]; then
    printf 'Initialize the Throughline Docker harness before launching containers.\n' >&2
    return 1
  fi
  if (($# < 2)); then
    printf 'Usage: throughline_docker_run CONTAINER_NAME [docker create arguments...] IMAGE [COMMAND...]\n' >&2
    return 1
  fi

  local name="$1"
  shift
  if [[ ! "$name" =~ ^throughline-[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    printf 'Refusing non-Throughline or malformed container name: %s\n' "$name" >&2
    return 1
  fi

  local argument
  for argument in "$@"; do
    case "$argument" in
      --rm|--rm=*)
        printf 'Do not use Docker --rm; deterministic cleanup requires docker rm -f -v.\n' >&2
        return 1
        ;;
      --name|--name=*)
        printf 'Do not override Docker --name; the harness owns the validated Throughline container name.\n' >&2
        return 1
        ;;
    esac
  done

  if grep -Fqx -- "$name" "$_THROUGHLINE_DOCKER_HARNESS_STATE_DIR/containers"; then
    printf 'Container is already registered with this harness: %s\n' "$name" >&2
    return 1
  fi

  local container_id
  if ! container_id="$(throughline_docker_cli create --name "$name" "$@")"; then
    return 1
  fi
  if ! printf '%s\n' "$name" >>"$_THROUGHLINE_DOCKER_HARNESS_STATE_DIR/containers"; then
    printf 'Unable to record container; removing it immediately: %s\n' "$name" >&2
    throughline_docker_cli rm -f -v "$name" >/dev/null 2>&1 || true
    return 1
  fi
  if ! throughline_docker_cli start "$name" >/dev/null; then
    printf 'Failed to start recorded Throughline test container: %s\n' "$name" >&2
    return 1
  fi
  printf '%s\n' "$container_id"
}

throughline_docker_harness_cleanup() {
  local state_dir="${_THROUGHLINE_DOCKER_HARNESS_STATE_DIR:-}"
  if [[ -z "$state_dir" ]]; then
    return 0
  fi

  # Clear first so a caller's EXIT trap can safely invoke cleanup more than once.
  _THROUGHLINE_DOCKER_HARNESS_STATE_DIR=""
  local cleanup_status=0 name raw_current current new_volumes

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if ! throughline_docker_cli rm -f -v "$name"; then
      printf 'Failed to remove Throughline test container and its anonymous volumes: %s\n' "$name" >&2
      cleanup_status=1
    fi
    if throughline_docker_cli container inspect "$name" >/dev/null 2>&1; then
      printf 'Throughline test container still exists after cleanup: %s\n' "$name" >&2
      cleanup_status=1
    fi
  done <"$state_dir/containers"

  raw_current="$state_dir/current.raw"
  current="$state_dir/current"
  new_volumes="$state_dir/new-volumes"
  if ! throughline_docker_cli volume ls --quiet --filter dangling=true >"$raw_current"; then
    printf 'Unable to inspect post-cleanup dangling Docker volumes.\n' >&2
    cleanup_status=1
  elif ! LC_ALL=C sort -u "$raw_current" >"$current"; then
    printf 'Unable to normalize post-cleanup dangling Docker volumes.\n' >&2
    cleanup_status=1
  elif ! LC_ALL=C comm -13 "$state_dir/baseline" "$current" >"$new_volumes"; then
    printf 'Unable to compare pre-run and post-cleanup Docker volume snapshots.\n' >&2
    cleanup_status=1
  elif [[ -s "$new_volumes" ]]; then
    printf 'New dangling Docker volumes remain after Throughline harness cleanup:\n' >&2
    while IFS= read -r name; do
      [[ -n "$name" ]] && printf '  %s\n' "$name" >&2
    done <"$new_volumes"
    cleanup_status=1
  fi

  rm -f "$state_dir/containers" "$state_dir/baseline" "$raw_current" "$current" "$new_volumes"
  if ! rmdir "$state_dir" 2>/dev/null; then
    printf 'Unable to remove Throughline Docker harness state directory: %s\n' "$state_dir" >&2
    cleanup_status=1
  fi
  return "$cleanup_status"
}
