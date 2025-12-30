# GitHub Issue Response: Spaces in MC_DEVICE_NAME

**Issue:** User @remowashere reported that the application fails when `MC_DEVICE_NAME` contains spaces (e.g., "Remo WebUI"), resulting in "file not found" errors for `.msgs` files.

---

Hi @remowashere,

Thanks for reporting this issue! I've investigated the problem with spaces in `MC_DEVICE_NAME` and did some testing.

**Good news:** The current version of mc-webui (on both `dev` and `main` branches) handles spaces in device names correctly. I tested with `MC_DEVICE_NAME="MarWoj Test"` and the application successfully reads the `.msgs` file without any issues:

```
mc-webui | INFO - Loaded 1 messages from /root/.config/meshcore/MarWoj Test.msgs
```

The application uses Python's `pathlib.Path` for file operations, which properly handles spaces and special characters in filenames.

## Possible causes of your issue

1. **Outdated version** - You might be running an older version of the application
2. **meshcore-cli version** - Older versions of meshcore-cli might have had issues creating files with spaces
3. **Configuration issue** - The `MC_DEVICE_NAME` environment variable might not match the actual device name used by meshcore-cli
4. **File permissions** - The `.msgs` file might not have been created yet or lacks proper permissions

## Recommended steps

### 1. Update to the latest version

```bash
cd ~/mc-webui
git pull origin main
docker compose down
docker compose up -d --build
```

### 2. Verify your configuration

```bash
# Check your .env file
cat .env | grep MC_DEVICE_NAME

# List actual .msgs files
ls -la ~/.config/meshcore/*.msgs
```

**Important:** Make sure the value of `MC_DEVICE_NAME` in your `.env` file matches the device name configured in meshcore-cli. The `.msgs` file is created by meshcore-cli using the device name you configured on the device itself.

### 3. Check logs for more details

```bash
docker compose logs -f mc-webui | grep -i "messages file"
```

Look for log lines indicating which file path the application is trying to access and whether it exists.

### 4. Verify meshcore-cli version

The application requires meshcore-cli >= 1.3.12. The Docker container installs the latest version automatically, but if you're running an older version, please update.

## Additional troubleshooting

If you're still experiencing issues after updating, please share:

1. **Docker logs:**
   ```bash
   docker compose logs --tail=100 mc-webui
   docker compose logs --tail=100 meshcore-bridge
   ```

2. **Git version:**
   ```bash
   git log -1 --oneline
   ```

3. **Environment configuration** (with sensitive data redacted):
   ```bash
   cat .env
   ```

4. **Actual .msgs files on disk:**
   ```bash
   ls -la ~/.config/meshcore/ | grep .msgs
   ```

This information will help me understand exactly what's happening in your environment.

Let me know if updating resolves the issue!

Best regards,
Marek
