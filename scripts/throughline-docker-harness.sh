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
      --cidfile|--cidfile=*)
        printf 'Do not override Docker --cidfile; the harness uses it to preserve immutable ownership.\n' >&2
        return 1
        ;;
    esac
  done

  local registered_id registered_name
  while IFS=$'\t' read -r registered_id registered_name; do
    if [[ "$registered_name" == "$name" ]]; then
      printf 'Container is already registered with this harness: %s\n' "$name" >&2
      return 1
    fi
  done <"$_THROUGHLINE_DOCKER_HARNESS_STATE_DIR/containers"

  local container_id pending_id pending_name
  pending_id="$_THROUGHLINE_DOCKER_HARNESS_STATE_DIR/pending-id"
  pending_name="$_THROUGHLINE_DOCKER_HARNESS_STATE_DIR/pending-name"
  if [[ -e "$pending_id" || -e "$pending_name" ]]; then
    printf 'A pending Throughline container identity requires cleanup before another launch.\n' >&2
    return 1
  fi
  if ! printf '%s\n' "$name" >"$pending_name"; then
    printf 'Unable to record the pending Throughline container name: %s\n' "$name" >&2
    return 1
  fi
  if ! throughline_docker_cli create --cidfile "$pending_id" --name "$name" "$@" >/dev/null; then
    if [[ ! -s "$pending_id" ]]; then
      rm -f "$pending_id" "$pending_name"
    fi
    return 1
  fi
  if [[ ! -s "$pending_id" ]]; then
    printf 'Docker create did not write an immutable container ID for %s.\n' "$name" >&2
    return 1
  fi
  container_id="$(<"$pending_id")"
  if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'Docker create wrote an invalid immutable container ID for %s; refusing name-based deletion.\n' "$name" >&2
    return 1
  fi
  if ! printf '%s\t%s\n' "$container_id" "$name" >>"$_THROUGHLINE_DOCKER_HARNESS_STATE_DIR/containers"; then
    printf 'Unable to record container; removing its exact ID immediately: %s (%s)\n' "$name" "$container_id" >&2
    if throughline_docker_cli rm -f -v "$container_id" >/dev/null 2>&1; then
      rm -f "$pending_id" "$pending_name"
    fi
    return 1
  fi
  rm -f "$pending_id" "$pending_name"
  if ! throughline_docker_cli start "$container_id" >/dev/null; then
    printf 'Failed to start recorded Throughline test container: %s (%s)\n' "$name" "$container_id" >&2
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
  local cleanup_status=0 container_id name raw_current current new_volumes
  local cleanup_entries cleanup_entries_unique pending_id pending_name
  cleanup_entries="$state_dir/cleanup-entries"
  cleanup_entries_unique="$state_dir/cleanup-entries-unique"
  pending_id="$state_dir/pending-id"
  pending_name="$state_dir/pending-name"

  if ! : >"$cleanup_entries"; then
    printf 'Unable to prepare Throughline container cleanup state.\n' >&2
    cleanup_status=1
  fi
  if [[ -s "$pending_id" && -s "$pending_name" ]]; then
    container_id="$(<"$pending_id")"
    name="$(<"$pending_name")"
    if [[ "$container_id" =~ ^[0-9a-f]{64}$ && "$name" =~ ^throughline-[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
      printf '%s\t%s\n' "$container_id" "$name" >>"$cleanup_entries" || cleanup_status=1
    else
      printf 'Invalid pending Throughline container identity; refusing name-based cleanup.\n' >&2
      cleanup_status=1
    fi
  elif [[ -e "$pending_id" || -e "$pending_name" ]]; then
    printf 'Incomplete pending Throughline container identity; refusing name-based cleanup.\n' >&2
    cleanup_status=1
  fi
  if ! cat "$state_dir/containers" >>"$cleanup_entries"; then
    printf 'Unable to read recorded Throughline container identities.\n' >&2
    cleanup_status=1
  fi
  if ! LC_ALL=C sort -u "$cleanup_entries" >"$cleanup_entries_unique"; then
    printf 'Unable to normalize recorded Throughline container identities.\n' >&2
    cleanup_status=1
  fi

  if [[ -f "$cleanup_entries_unique" ]]; then
    while IFS=$'\t' read -r container_id name || [[ -n "$container_id" ]]; do
      [[ -n "$container_id" && -n "$name" ]] || continue
      if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ || ! "$name" =~ ^throughline-[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
        printf 'Invalid recorded Throughline container identity; refusing cleanup entry.\n' >&2
        cleanup_status=1
        continue
      fi
      if ! throughline_docker_cli rm -f -v "$container_id"; then
        printf 'Failed to remove exact Throughline test container and its anonymous volumes: %s (%s)\n' "$name" "$container_id" >&2
        cleanup_status=1
      fi
      if throughline_docker_cli container inspect "$container_id" >/dev/null 2>&1; then
        printf 'Exact Throughline test container still exists after cleanup: %s (%s)\n' "$name" "$container_id" >&2
        cleanup_status=1
      fi
    done <"$cleanup_entries_unique"
  fi

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

  rm -f \
    "$state_dir/containers" \
    "$state_dir/baseline" \
    "$pending_id" \
    "$pending_name" \
    "$cleanup_entries" \
    "$cleanup_entries_unique" \
    "$raw_current" \
    "$current" \
    "$new_volumes"
  if ! rmdir "$state_dir" 2>/dev/null; then
    printf 'Unable to remove Throughline Docker harness state directory: %s\n' "$state_dir" >&2
    cleanup_status=1
  fi
  return "$cleanup_status"
}
