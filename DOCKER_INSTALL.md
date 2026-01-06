# How to Install Docker Engine on Debian / Ubuntu

This guide provides step-by-step instructions for installing Docker Engine on a Debian-based system using Docker's official repository. This is the recommended method as it ensures you get the latest and most stable version.

-----

### Step 1: Set Up the Docker Repository

Next, configure your system to download packages from the official Docker repository instead of the default Debian repository.

#### a. Update the package index and install dependencies:

```bash
sudo apt-get update
sudo apt-get install ca-certificates curl
```

#### b. Add Docker’s official GPG key:

This step ensures that the packages you download are authentic.

```bash
sudo install -m 0755 -d /etc/apt/keyrings && \
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

#### c. Add the repository to your APT sources:

This command automatically detects your Debian version and sets up the repository accordingly.

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

-----

### Step 2: Install Docker Engine

Now you can install the latest version of Docker Engine and its related components.

#### a. Update the package index again:

```bash
sudo apt-get update
```

#### b. Install Docker Engine, CLI, Containerd, and Compose plugin:

The `docker-compose-plugin` package provides the `docker compose` command.

```bash
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

-----

### Step 3: Verify the Installation ✅

Run the `hello-world` image to confirm that Docker Engine is installed and running correctly.

```bash
sudo docker run hello-world
```

If the installation was successful, you will see a "Hello from Docker\!" message in your terminal.

-----

### Step 4 (Optional): Manage Docker as a Non-root User

To avoid typing `sudo` every time you run a Docker command, add your user to the `docker` group.

#### a. Create the `docker` group (if it doesn't already exist):

```bash
sudo groupadd docker
```

#### b. Add your user to the `docker` group:

```bash
sudo usermod -aG docker $USER
```

**Important:** You need to **log out and log back in** for this change to take effect. Alternatively, you can run `newgrp docker` in your current terminal session to activate the new group membership.

After this, you can run Docker commands directly (e.g., `docker ps`).