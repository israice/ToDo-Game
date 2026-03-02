"""
Bitwarden Secrets Manager (BWS) loader.
Reads BWS_* mappings from environment, fetches secrets via bws CLI,
and sets them as environment variables before app startup.
"""
import os
import json
import subprocess

BWS_CONFIG_KEYS = {"BITWARDEN_ENABLED", "BITWARDEN_PROVIDER", "BWS_ACCESS_TOKEN", "BWS_PROJECT_ID", "BWS_REQUIRE_WRITE"}


def load_bws_secrets():
    """Fetch secrets from Bitwarden and inject into os.environ."""
    if os.environ.get("_BWS_LOADED"):
        return
    if os.environ.get("BITWARDEN_ENABLED") != "1":
        print("BWS: disabled")
        return

    access_token = os.environ.get("BWS_ACCESS_TOKEN", "").strip('"')
    project_id = os.environ.get("BWS_PROJECT_ID", "").strip('"')

    if not access_token or not project_id:
        print("WARNING: BWS enabled but BWS_ACCESS_TOKEN or BWS_PROJECT_ID missing")
        return

    # Collect mappings: BWS_SECRET_KEY=SECRET_KEY → env var "SECRET_KEY", bws key "SECRET_KEY"
    mappings = {}
    for key, value in os.environ.items():
        if key.startswith("BWS_") and key not in BWS_CONFIG_KEYS and value:
            env_var = key[4:]  # strip "BWS_" prefix
            bws_key = value    # the secret name in Bitwarden
            mappings[bws_key] = env_var

    if not mappings:
        print("WARNING: BWS enabled but no BWS_* secret mappings found")
        return

    # Fetch all secrets from BWS project
    try:
        result = subprocess.run(
            ["bws", "secret", "list", project_id],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "BWS_ACCESS_TOKEN": access_token}
        )
        if result.returncode != 0:
            print(f"ERROR: BWS fetch failed: {result.stderr.strip()}")
            return

        secrets = json.loads(result.stdout)
    except FileNotFoundError:
        print("ERROR: bws CLI not found. Install: https://bitwarden.com/help/secrets-manager-cli/")
        return
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"ERROR: BWS error: {e}")
        return

    # Build lookup: secret key → secret value
    bws_secrets = {s["key"]: s["value"] for s in secrets}

    # Inject into environment
    loaded = []
    missing = []
    for bws_key, env_var in mappings.items():
        if bws_key in bws_secrets:
            os.environ[env_var] = bws_secrets[bws_key]
            loaded.append(env_var)
        else:
            missing.append(bws_key)

    if loaded:
        print(f"BWS: loaded {len(loaded)} secrets -> {', '.join(loaded)}")
    if missing:
        print(f"WARNING: BWS secrets not found: {', '.join(missing)}")

    os.environ["_BWS_LOADED"] = "1"
