# Migration Guide - Moving Data to Project Directory

This guide helps you migrate from the old configuration (data stored outside project) to the new configuration (all data in `./data/` inside project).

## Who Needs This Guide?

If you installed mc-webui **before 2025-12-29** and your `.env` file contains **absolute paths** (starting with `/`) like these examples:
```bash
MC_CONFIG_DIR=/home/marek/.config/meshcore
MC_CONFIG_DIR=/opt/meshcore
MC_CONFIG_DIR=/var/lib/meshcore
# ... or any other absolute path outside the project directory
```

Then you should follow this migration guide to move your data into the project directory.

**You do NOT need this guide if:**
- Your `.env` already has `MC_CONFIG_DIR=./data/meshcore` (you're already using the new structure)
- You just installed mc-webui for the first time

## Why Migrate?

**Benefits of new structure:**
- ✅ All project data in one place (easier backups)
- ✅ No dependency on host directories
- ✅ Better isolation and portability
- ✅ Simpler setup for new deployments

## Before You Start

**⚠️ IMPORTANT: Check your current paths!**

Before proceeding, you need to know where YOUR data is currently stored. Run this command to check your current configuration:

```bash
cd ~/mc-webui
grep -E "^MC_CONFIG_DIR|^MC_ARCHIVE_DIR" .env
```

**Example output:**
```
MC_CONFIG_DIR=/home/marek/.config/meshcore
MC_ARCHIVE_DIR=/home/marek/.config/meshcore/archive
```

**Write down these paths!** You will need them in the following steps. Replace any example paths shown below with YOUR actual paths from the .env file.

## Migration Steps

### Step 1: Stop the Application

```bash
cd ~/mc-webui
docker compose down
```

### Step 2: Backup Your Current Data

**Important:** Always backup before migration!

**Replace the paths below with YOUR paths from the previous check!**

```bash
# IMPORTANT: Replace /home/marek/.config/meshcore with YOUR MC_CONFIG_DIR path!
# Example command (adjust paths to match your .env):
tar -czf ~/mc-webui-backup-$(date +%Y%m%d).tar.gz \
  /home/marek/.config/meshcore/*.msgs \
  /home/marek/.config/meshcore/*.adverts.jsonl \
  /home/marek/.config/meshcore/*_dm_sent.jsonl \
  /home/marek/.config/meshcore/.webui_settings.json \
  /home/marek/.config/meshcore/archive/
```

**If your MC_CONFIG_DIR is different, use it instead!** For example:
- If `MC_CONFIG_DIR=/opt/meshcore`, use `/opt/meshcore/*.msgs` etc.
- If `MC_CONFIG_DIR=/var/lib/meshcore`, use `/var/lib/meshcore/*.msgs` etc.

Verify backup was created:
```bash
ls -lh ~/mc-webui-backup-*.tar.gz
```

### Step 3: Create New Data Directory Structure

```bash
cd ~/mc-webui

# Create new directory structure
mkdir -p data/meshcore
mkdir -p data/archive
```

### Step 4: Copy Existing Data

**⚠️ IMPORTANT: Use YOUR paths from the "Before You Start" check!**

The commands below use `/home/marek/.config/meshcore` as an example. **Replace it with your actual MC_CONFIG_DIR path!**

```bash
# Copy meshcore configuration files
# Replace /home/marek/.config/meshcore with YOUR MC_CONFIG_DIR path!
cp /home/marek/.config/meshcore/*.msgs data/meshcore/ 2>/dev/null || true
cp /home/marek/.config/meshcore/*.adverts.jsonl data/meshcore/ 2>/dev/null || true
cp /home/marek/.config/meshcore/*_dm_sent.jsonl data/meshcore/ 2>/dev/null || true
cp /home/marek/.config/meshcore/.webui_settings.json data/meshcore/ 2>/dev/null || true

# Copy archive files
# Replace /home/marek/.config/meshcore/archive with YOUR MC_ARCHIVE_DIR path!
cp -r /home/marek/.config/meshcore/archive/* data/archive/ 2>/dev/null || true
```

**Alternative: Use variables for easier path substitution**

```bash
# Set your paths from .env (replace with YOUR actual paths!)
OLD_CONFIG_DIR="/home/marek/.config/meshcore"
OLD_ARCHIVE_DIR="/home/marek/.config/meshcore/archive"

# Copy files using variables
cp $OLD_CONFIG_DIR/*.msgs data/meshcore/ 2>/dev/null || true
cp $OLD_CONFIG_DIR/*.adverts.jsonl data/meshcore/ 2>/dev/null || true
cp $OLD_CONFIG_DIR/*_dm_sent.jsonl data/meshcore/ 2>/dev/null || true
cp $OLD_CONFIG_DIR/.webui_settings.json data/meshcore/ 2>/dev/null || true
cp -r $OLD_ARCHIVE_DIR/* data/archive/ 2>/dev/null || true
```

Verify files were copied:
```bash
ls -la data/meshcore/
ls -la data/archive/
```

### Step 5: Update .env File

**Goal:** Change your old paths to new project-relative paths.

**Old configuration (your current paths):**
```bash
MC_CONFIG_DIR=/home/marek/.config/meshcore    # Example - yours may be different!
MC_ARCHIVE_DIR=/home/marek/.config/meshcore/archive    # Example - yours may be different!
```

**New configuration (same for everyone):**
```bash
MC_CONFIG_DIR=./data/meshcore
MC_ARCHIVE_DIR=./data/archive
```

**Option A: Automatic update with sed (recommended)**

This will work regardless of your old paths:

```bash
cd ~/mc-webui

# Backup .env
cp .env .env.backup

# Update MC_CONFIG_DIR (replaces any old path with new one)
sed -i 's|MC_CONFIG_DIR=.*|MC_CONFIG_DIR=./data/meshcore|' .env

# Update MC_ARCHIVE_DIR (replaces any old path with new one)
sed -i 's|MC_ARCHIVE_DIR=.*|MC_ARCHIVE_DIR=./data/archive|' .env
```

**Option B: Manual edit**

```bash
nano .env
# Change MC_CONFIG_DIR to: ./data/meshcore
# Change MC_ARCHIVE_DIR to: ./data/archive
# Save and exit (Ctrl+O, Enter, Ctrl+X)
```

**Verify changes (IMPORTANT!):**
```bash
grep -E "MC_CONFIG_DIR|MC_ARCHIVE_DIR" .env
```

**Expected output (should be the same for everyone):**
```
MC_CONFIG_DIR=./data/meshcore
MC_ARCHIVE_DIR=./data/archive
```

If you see anything different, fix it before proceeding!

### Step 6: Set Correct Permissions

```bash
# Ensure Docker can read/write the data directory
chmod -R 755 data/
```

### Step 7: Restart Application

```bash
cd ~/mc-webui
docker compose up -d --build
```

### Step 8: Verify Migration

Check that the application is running correctly:

```bash
# Check container status
docker compose ps

# Check logs for errors
docker compose logs -f mc-webui
docker compose logs -f meshcore-bridge

# Verify data files are accessible in containers
docker compose exec mc-webui ls -la /root/.config/meshcore/
docker compose exec mc-webui ls -la /root/.archive/meshcore/
```

**Test the web interface:**
1. Open http://localhost:5000 (or your server IP)
2. Verify that old messages are visible
3. Send a test message to confirm everything works
4. Check if your contact list is preserved
5. Verify archived messages are accessible (if you had any)

### Step 9: Cleanup (Optional)

**⚠️ DANGER ZONE - Only after confirming everything works!**

If you're confident the migration was successful and have tested the application for several days, you can remove old data.

**⚠️ USE YOUR OLD PATH - not the example below!**

```bash
# CAREFUL! This deletes old data permanently
# Only run this after verifying the new setup works!

# Remove old meshcore data
# Replace /home/marek/.config/meshcore with YOUR old MC_CONFIG_DIR path!
rm -rf /home/marek/.config/meshcore/

# Alternative: Use the path from your .env.backup
OLD_PATH=$(grep "^MC_CONFIG_DIR=" .env.backup | cut -d'=' -f2)
echo "About to delete: $OLD_PATH"
# Verify the path is correct, then uncomment the line below:
# rm -rf "$OLD_PATH"

# Remove backup after a few days of successful operation
# rm ~/mc-webui-backup-*.tar.gz
```

**Recommendations:**
- Keep the backup for at least **one week** before deleting it
- Test all features before cleanup (messaging, channels, DM, contacts, archives)
- Consider keeping old data as additional backup for a month

## Troubleshooting

### Issue: No messages visible after migration

**Solution:**
1. Check if files were copied correctly:
   ```bash
   ls -la data/meshcore/
   ```
2. Verify the `.msgs` file exists and has content:
   ```bash
   cat data/meshcore/MarWoj.msgs  # Replace MarWoj with your device name
   ```
3. Check container logs for errors:
   ```bash
   docker compose logs mc-webui | grep -i error
   ```

### Issue: Permission denied errors

**Solution:**
```bash
# Fix permissions
sudo chown -R $USER:$USER data/
chmod -R 755 data/
```

### Issue: Archives not showing

**Solution:**
1. Check if archive files exist:
   ```bash
   ls -la data/archive/
   ```
2. Verify MC_ARCHIVE_DIR in .env:
   ```bash
   grep MC_ARCHIVE_DIR .env
   ```
3. Restart the application:
   ```bash
   docker compose restart
   ```

### Issue: Contact settings lost

**Solution:**
1. Check if `.webui_settings.json` was copied:
   ```bash
   cat data/meshcore/.webui_settings.json
   ```
2. If missing, recreate it manually:
   ```bash
   echo '{"manual_add_contacts": false}' > data/meshcore/.webui_settings.json
   ```
3. Restart bridge:
   ```bash
   docker compose restart meshcore-bridge
   ```

## Rollback Plan

If migration fails and you need to rollback:

```bash
# Stop containers
docker compose down

# Restore .env from backup
cd ~/mc-webui
cp .env.backup .env

# Remove new data directory (optional)
rm -rf data/

# Restore from backup
cd ~
tar -xzf mc-webui-backup-*.tar.gz

# Start with old configuration
cd ~/mc-webui
docker compose up -d
```

## Getting Help

If you encounter issues during migration:

1. Check the logs:
   ```bash
   docker compose logs -f
   ```

2. Verify your configuration:
   ```bash
   cat .env | grep -E "MC_CONFIG_DIR|MC_ARCHIVE_DIR|MC_DEVICE_NAME"
   ```

3. Report the issue on GitHub:
   - Repository: https://github.com/MarekWo/mc-webui
   - Include: error logs, .env configuration (remove sensitive data), system info

## Summary

After successful migration:
- ✅ All data is in `./data/` directory inside project
- ✅ Configuration uses relative paths (`./data/meshcore`, `./data/archive`)
- ✅ Backups are simpler (just backup the `data/` directory)
- ✅ Project is more portable (can move entire directory to another server)

**Next steps:**
- Keep backup for at least one week
- Test all features (messaging, channels, DM, contacts, archives)
- Consider setting up automated backups of `./data/` directory
