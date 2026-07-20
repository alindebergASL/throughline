#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$repo_root/scripts/throughline-docker-harness.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/throughline-docker-harness-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fake_docker="$test_root/fake-docker"
cat >"$fake_docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_DOCKER_STATE:?}"
printf '%q ' "$@" >>"$FAKE_DOCKER_STATE/invocations.log"
printf '\n' >>"$FAKE_DOCKER_STATE/invocations.log"
command_name="${1:-}"
subcommand="${2:-}"

resolve_container_reference() {
  local reference="$1"
  if [[ -e "$FAKE_DOCKER_STATE/containers/$reference" ]]; then
    RESOLVED_NAME="$reference"
    RESOLVED_ID="$(<"$FAKE_DOCKER_STATE/container-ids/$reference")"
    return 0
  fi
  if [[ -e "$FAKE_DOCKER_STATE/ids/$reference" ]]; then
    RESOLVED_ID="$reference"
    RESOLVED_NAME="$(<"$FAKE_DOCKER_STATE/ids/$reference")"
    return 0
  fi
  return 1
}

if [[ "$command_name" == "volume" && "$subcommand" == "ls" ]]; then
  sort -u "$FAKE_DOCKER_STATE/dangling"
  exit 0
fi

if [[ "$command_name" == "run" || "$command_name" == "create" ]]; then
  lifecycle_command="$command_name"
  shift
  name=""
  cidfile=""
  while (($#)); do
    if [[ "$1" == "--name" ]]; then
      name="${2:-}"
      shift 2
      continue
    fi
    if [[ "$1" == --name=* ]]; then
      name="${1#--name=}"
      shift
      continue
    fi
    if [[ "$1" == "--cidfile" ]]; then
      cidfile="${2:-}"
      shift 2
      continue
    fi
    if [[ "$1" == --cidfile=* ]]; then
      cidfile="${1#--cidfile=}"
      shift
      continue
    fi
    shift
  done
  [[ -n "$name" ]]
  if [[ "${FAKE_DOCKER_FAIL_CREATE:-0}" == "1" ]]; then
    exit 125
  fi
  [[ ! -e "$FAKE_DOCKER_STATE/containers/$name" ]]
  counter="$(<"$FAKE_DOCKER_STATE/counter")"
  counter=$((counter + 1))
  printf '%s\n' "$counter" >"$FAKE_DOCKER_STATE/counter"
  printf -v container_id '%064x' "$counter"
  touch "$FAKE_DOCKER_STATE/containers/$name"
  printf '%s\n' "$container_id" >"$FAKE_DOCKER_STATE/container-ids/$name"
  printf '%s\n' "$name" >"$FAKE_DOCKER_STATE/ids/$container_id"
  printf 'anonymous-%s\n' "$counter" >"$FAKE_DOCKER_STATE/volumes/$name"
  if [[ -n "$cidfile" && "${FAKE_DOCKER_SKIP_CIDFILE:-0}" != "1" ]]; then
    if [[ "${FAKE_DOCKER_MALFORMED_CIDFILE:-0}" == "1" ]]; then
      printf 'not-a-container-id\n' >"$cidfile"
    else
      printf '%s\n' "$container_id" >"$cidfile"
    fi
  fi
  if [[ "${FAKE_DOCKER_FAIL_AFTER_CIDFILE:-0}" == "1" ]]; then
    exit 125
  fi
  if [[ "$lifecycle_command" == "run" && "${FAKE_DOCKER_FAIL_START:-0}" == "1" ]]; then
    exit 125
  fi
  printf '%s\n' "$container_id"
  exit 0
fi

if [[ "$command_name" == "start" ]]; then
  reference="${2:-}"
  resolve_container_reference "$reference"
  if [[ "${FAKE_DOCKER_FAIL_START:-0}" == "1" ]]; then
    exit 125
  fi
  printf '%s\n' "$reference"
  exit 0
fi

if [[ "$command_name" == "rm" ]]; then
  shift
  remove_volumes=0
  references=()
  while (($#)); do
    case "$1" in
      -v|--volumes|-fv|-vf)
        remove_volumes=1
        ;;
      -f|--force)
        ;;
      *)
        references+=("$1")
        ;;
    esac
    shift
  done
  for reference in "${references[@]}"; do
    resolve_container_reference "$reference"
    name="$RESOLVED_NAME"
    container_id="$RESOLVED_ID"
    if [[ "${FAKE_DOCKER_FAIL_RM:-0}" == "1" ]]; then
      exit 1
    fi
    if ((remove_volumes == 0)); then
      cat "$FAKE_DOCKER_STATE/volumes/$name" >>"$FAKE_DOCKER_STATE/dangling"
    fi
    if [[ "${FAKE_DOCKER_KEEP_CONTAINER:-0}" != "1" ]]; then
      rm -f \
        "$FAKE_DOCKER_STATE/containers/$name" \
        "$FAKE_DOCKER_STATE/container-ids/$name" \
        "$FAKE_DOCKER_STATE/ids/$container_id" \
        "$FAKE_DOCKER_STATE/volumes/$name"
    fi
    printf '%s\n' "$reference"
  done
  exit 0
fi

if [[ "$command_name" == "container" && "$subcommand" == "inspect" ]]; then
  reference="${3:-}"
  resolve_container_reference "$reference"
  exit 0
fi

printf 'unsupported fake docker invocation:' >&2
printf ' %q' "$command_name" "$subcommand" >&2
printf '\n' >&2
exit 64
FAKE
chmod +x "$fake_docker"

new_state() {
  local state="$1"
  mkdir -p "$state/containers" "$state/container-ids" "$state/ids" "$state/volumes"
  : >"$state/dangling"
  : >"$state/invocations.log"
  printf '0\n' >"$state/counter"
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -F -- "$expected" "$file" >/dev/null; then
    printf 'expected %s to contain: %s\n' "$file" "$expected" >&2
    return 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -F -- "$unexpected" "$file" >/dev/null; then
    printf 'expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    return 1
  fi
}

run_cleanup_case() (
  set -euo pipefail
  local state="$test_root/cleanup" container_id
  new_state "$state"
  printf 'preserved-before-run\n' >"$state/dangling"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  container_id="$(throughline_docker_run throughline-harness-test-pg fake/pgvector:test)"
  throughline_docker_harness_cleanup
  throughline_docker_harness_cleanup

  [[ "$(cat "$state/dangling")" == "preserved-before-run" ]]
  [[ ! -e "$state/containers/throughline-harness-test-pg" ]]
  assert_contains "$state/invocations.log" "--name throughline-harness-test-pg fake/pgvector:test"
  assert_contains "$state/invocations.log" "start $container_id"
  assert_contains "$state/invocations.log" "rm -f -v $container_id"
  assert_not_contains "$state/invocations.log" "rm -f -v throughline-harness-test-pg"
  assert_not_contains "$state/invocations.log" "run -d"
  assert_not_contains "$state/invocations.log" "--rm"
)

run_reject_auto_remove_case() (
  set -euo pipefail
  local state="$test_root/reject-auto-remove"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if throughline_docker_run throughline-harness-test-pg --rm fake/pgvector:test; then
    printf 'expected caller-supplied --rm to be rejected\n' >&2
    exit 1
  fi
  if throughline_docker_run throughline-harness-test-pg --cidfile "$state/caller.cid" fake/pgvector:test; then
    printf 'expected caller-supplied --cidfile to be rejected\n' >&2
    exit 1
  fi
  if throughline_docker_run throughline-harness-test-pg --cidfile="$state/caller.cid" fake/pgvector:test; then
    printf 'expected caller-supplied --cidfile=... to be rejected\n' >&2
    exit 1
  fi
  throughline_docker_harness_cleanup
  assert_not_contains "$state/invocations.log" "create "
)

run_leak_detection_case() (
  set -euo pipefail
  local state="$test_root/leak-detection"
  new_state "$state"
  printf 'preserved-before-run\n' >"$state/dangling"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  printf 'unexpected-new-volume\n' >>"$state/dangling"
  if throughline_docker_harness_cleanup >"$state/cleanup.out" 2>"$state/cleanup.err"; then
    printf 'expected cleanup to fail when a new dangling volume remains\n' >&2
    exit 1
  fi
  assert_contains "$state/cleanup.err" "unexpected-new-volume"
)

run_name_scope_case() (
  set -euo pipefail
  local state="$test_root/name-scope"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if throughline_docker_run unrelated-container fake/pgvector:test; then
    printf 'expected a non-Throughline container name to be rejected\n' >&2
    exit 1
  fi
  throughline_docker_harness_cleanup
  assert_not_contains "$state/invocations.log" "create "
)

run_name_override_case() (
  set -euo pipefail
  local mode="$1" state="$test_root/name-override-$1"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if [[ "$mode" == "split" ]]; then
    if throughline_docker_run throughline-harness-test-pg --name unrelated-container fake/pgvector:test; then
      printf 'expected caller-supplied --name to be rejected\n' >&2
      exit 1
    fi
  elif throughline_docker_run throughline-harness-test-pg --name=unrelated-container fake/pgvector:test; then
    printf 'expected caller-supplied --name=... to be rejected\n' >&2
    exit 1
  fi
  throughline_docker_harness_cleanup
  assert_not_contains "$state/invocations.log" "create "
)

run_start_failure_case() (
  set -euo pipefail
  local state="$test_root/start-failure" container_id
  new_state "$state"
  printf 'preserved-before-run\n' >"$state/dangling"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  export FAKE_DOCKER_FAIL_START=1
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if throughline_docker_run throughline-harness-test-pg fake/pgvector:test; then
    printf 'expected a Docker start failure to propagate\n' >&2
    exit 1
  fi
  container_id="$(<"$state/container-ids/throughline-harness-test-pg")"
  unset FAKE_DOCKER_FAIL_START
  throughline_docker_harness_cleanup
  [[ ! -e "$state/containers/throughline-harness-test-pg" ]]
  [[ "$(cat "$state/dangling")" == "preserved-before-run" ]]
  assert_contains "$state/invocations.log" "--name throughline-harness-test-pg"
  assert_contains "$state/invocations.log" "start $container_id"
  assert_contains "$state/invocations.log" "rm -f -v $container_id"
)

run_remove_failure_case() (
  set -euo pipefail
  local state="$test_root/remove-failure"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  throughline_docker_run throughline-harness-test-pg fake/pgvector:test
  export FAKE_DOCKER_FAIL_RM=1
  if throughline_docker_harness_cleanup >"$state/cleanup.out" 2>"$state/cleanup.err"; then
    printf 'expected a Docker remove failure to propagate\n' >&2
    exit 1
  fi
  assert_contains "$state/cleanup.err" "throughline-harness-test-pg"
)

run_still_present_case() (
  set -euo pipefail
  local state="$test_root/still-present"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  throughline_docker_run throughline-harness-test-pg fake/pgvector:test
  export FAKE_DOCKER_KEEP_CONTAINER=1
  if throughline_docker_harness_cleanup >"$state/cleanup.out" 2>"$state/cleanup.err"; then
    printf 'expected a still-present container to fail cleanup\n' >&2
    exit 1
  fi
  assert_contains "$state/cleanup.err" "still exists after cleanup"
)

run_trap_status_case() {
  local label="$1" original_status="$2" remove_failure="$3" expected_status="$4"
  local state="$test_root/trap-$label" observed_status
  new_state "$state"

  if (
    set -euo pipefail
    export FAKE_DOCKER_STATE="$state"
    export THROUGHLINE_DOCKER_BIN="$fake_docker"
    # shellcheck source=/dev/null
    source "$helper"

    cleanup() {
      local rc=$? cleanup_rc
      trap - EXIT INT TERM
      set +e
      throughline_docker_harness_cleanup
      cleanup_rc=$?
      if [[ "$rc" -eq 0 && "$cleanup_rc" -ne 0 ]]; then rc="$cleanup_rc"; fi
      exit "$rc"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    throughline_docker_harness_init
    throughline_docker_run throughline-harness-test-pg fake/pgvector:test
    if [[ "$remove_failure" == "1" ]]; then
      export FAKE_DOCKER_FAIL_RM=1
    fi
    exit "$original_status"
  ); then
    observed_status=0
  else
    observed_status=$?
  fi

  [[ "$observed_status" -eq "$expected_status" ]]
  if [[ "$remove_failure" == "0" ]]; then
    [[ ! -e "$state/containers/throughline-harness-test-pg" ]]
  fi
}

run_create_failure_retry_case() (
  set -euo pipefail
  local state="$test_root/create-failure" container_id
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  export FAKE_DOCKER_FAIL_CREATE=1
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if throughline_docker_run throughline-harness-test-pg fake/pgvector:test; then
    printf 'expected Docker create failure to propagate\n' >&2
    exit 1
  fi
  unset FAKE_DOCKER_FAIL_CREATE
  container_id="$(throughline_docker_run throughline-harness-test-pg fake/pgvector:test)"
  throughline_docker_harness_cleanup
  [[ ! -e "$state/containers/throughline-harness-test-pg" ]]
  assert_contains "$state/invocations.log" "rm -f -v $container_id"
)

run_pending_identity_recovery_case() (
  set -euo pipefail
  local state="$test_root/pending-identity" container_id
  new_state "$state"
  printf 'preserved-before-run\n' >"$state/dangling"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  export FAKE_DOCKER_FAIL_AFTER_CIDFILE=1
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if throughline_docker_run throughline-harness-test-pg fake/pgvector:test; then
    printf 'expected Docker failure after cidfile creation to propagate\n' >&2
    exit 1
  fi
  unset FAKE_DOCKER_FAIL_AFTER_CIDFILE
  if throughline_docker_run throughline-harness-test-second fake/pgvector:test; then
    printf 'expected unresolved pending identity to block a second launch\n' >&2
    exit 1
  fi
  [[ "$(grep -c '^create ' "$state/invocations.log")" -eq 1 ]]
  container_id="$(<"$state/container-ids/throughline-harness-test-pg")"
  throughline_docker_harness_cleanup
  [[ ! -e "$state/containers/throughline-harness-test-pg" ]]
  [[ "$(<"$state/dangling")" == "preserved-before-run" ]]
  assert_contains "$state/invocations.log" "rm -f -v $container_id"
  assert_not_contains "$state/invocations.log" "rm -f -v throughline-harness-test-pg"
)

run_invalid_cidfile_case() (
  set -euo pipefail
  local mode="$1" state="$test_root/invalid-cidfile-$1"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  if [[ "$mode" == "malformed" ]]; then
    export FAKE_DOCKER_MALFORMED_CIDFILE=1
  else
    export FAKE_DOCKER_SKIP_CIDFILE=1
  fi
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  if throughline_docker_run throughline-harness-test-pg fake/pgvector:test; then
    printf 'expected invalid Docker cidfile output to fail the launch\n' >&2
    exit 1
  fi
  if throughline_docker_harness_cleanup >"$state/cleanup.out" 2>"$state/cleanup.err"; then
    printf 'expected invalid pending identity to fail cleanup\n' >&2
    exit 1
  fi
  [[ -e "$state/containers/throughline-harness-test-pg" ]]
  assert_not_contains "$state/invocations.log" "rm -f -v throughline-harness-test-pg"
)

run_name_reuse_identity_case() (
  set -euo pipefail
  local state="$test_root/name-reuse" original_id replacement_id removal_count
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  original_id="$(throughline_docker_run throughline-harness-test-pg fake/pgvector:test)"

  # Simulate an external actor removing the harness container and reusing its
  # mutable name before the harness trap runs.
  "$fake_docker" rm -f -v "$original_id" >/dev/null
  replacement_id="$("$fake_docker" create --name throughline-harness-test-pg fake/replacement:test)"
  "$fake_docker" start "$replacement_id" >/dev/null

  if throughline_docker_harness_cleanup >"$state/cleanup.out" 2>"$state/cleanup.err"; then
    printf 'expected missing original container ID to fail cleanup\n' >&2
    exit 1
  fi

  [[ -e "$state/containers/throughline-harness-test-pg" ]]
  [[ "$(<"$state/container-ids/throughline-harness-test-pg")" == "$replacement_id" ]]
  removal_count="$(grep -F -c -- "rm -f -v $original_id" "$state/invocations.log")"
  [[ "$removal_count" -eq 2 ]]
  assert_not_contains "$state/invocations.log" "rm -f -v $replacement_id"
)

run_resource_case() (
  set -euo pipefail
  local state="$test_root/resource"
  new_state "$state"
  export FAKE_DOCKER_STATE="$state"
  export THROUGHLINE_DOCKER_BIN="$fake_docker"
  # shellcheck source=/dev/null
  source "$helper"

  throughline_docker_harness_init
  throughline_docker_run throughline-harness-test-pg fake/pgvector:test
  # A generated harness may source shared setup more than once. Re-sourcing must
  # not discard the active state needed to remove an already-created container.
  source "$helper"
  throughline_docker_harness_cleanup
  [[ ! -e "$state/containers/throughline-harness-test-pg" ]]
)

run_cleanup_case
run_reject_auto_remove_case
run_leak_detection_case
run_name_scope_case
run_name_override_case split
run_name_override_case equals
run_start_failure_case
run_remove_failure_case
run_still_present_case
run_trap_status_case preserve-original 7 0 7
run_trap_status_case adopt-cleanup-failure 0 1 1
run_create_failure_retry_case
run_pending_identity_recovery_case
run_invalid_cidfile_case malformed
run_invalid_cidfile_case missing
run_name_reuse_identity_case
run_resource_case
printf 'throughline docker harness tests: PASS\n'
