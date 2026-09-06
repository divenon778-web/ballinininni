# BloxFlip MODDED

![Preview](https://repository-images.githubusercontent.com/1352691962/9e515b98-e0b3-4152-931a-5514902d37c7)

> **Unofficial local-only entertainment project.**
>
> BloxFlip MODDED is not affiliated with, endorsed by, sponsored by, or operated by the real BloxFlip.

BloxFlip MODDED is a local recreation/modification of the BloxFlip experience created for entertainment, experimentation, preservation of UI/game mechanics, and playing locally with virtual currency.

The project is designed to run on your own computer using `localhost`.

## ⚠️ Important: Local Use Only

**This project is NOT production-ready and is NOT intended to be hosted on a public or real server.**

It has not been designed, audited, hardened, or secured for production deployment.

Do not expose this application directly to the public Internet.

In particular, this project should **not** be used as:

- a real gambling website;
- a real-money platform;
- a Robux gambling platform;
- a cryptocurrency platform;
- a deposit or withdrawal service;
- a production authentication system;
- a service that stores sensitive user information;
- a commercial BloxFlip replacement.

The local backend was created specifically to make the saved frontend and game interfaces usable for entertainment on a local computer. Its architecture and security model should not be treated as suitable for a publicly accessible service.
This was made using AI so do not host it publically or do it at your own risk.

## What is BloxFlip MODDED?

BloxFlip MODDED recreates various BloxFlip interfaces and games while replacing real-value systems with a local virtual currency called **FlipCoins**.

FlipCoins:

- have no monetary value;
- cannot be exchanged for money;
- cannot be exchanged for cryptocurrency;
- cannot be exchanged for Robux;
- cannot be withdrawn;
- exist only inside the local application.

The project is intended to let users explore and play with the interface and game mechanics without using real money, external currencies, or tradable items.

## Included Games

The local build contains recreations of several game interfaces, including:

- # Crash
  ![Preview2](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p2.png?raw=true)
- # Slide
  ![Preview3](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p9.png?raw=true)
- # Cups
  ![Preview4](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p11.png?raw=true)
- # Mines
  ![Preview5](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p7.png?raw=true)
- # Towers
  ![Preview6](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p8.png?raw=true)
- # Blackjack
  ![Preview7](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p5.png?raw=true)
- # Dice
  ![Preview8](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p6.png?raw=true)
- # Plinko
  ![Preview9](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p10.png?raw=true)
- # Upgrader
  ![Preview10](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p12.png?raw=true)
- # Cases
  ![Preview11](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p3.png?raw=true)
- # Case Battles
  ![Preview12](https://github.com/StylishYan/BloxFlip-Modded/blob/main/previews/p4.png?raw=true)

Some original BloxFlip functionality has intentionally been removed, disabled, hidden, or replaced because it does not make sense in a local entertainment build.

## Requirements

Recommended environment:

- Windows 10/11
- **Node.js version 18+**
- Browser
- Internet access may be required for some optional Roblox profile/avatar lookups

No external database is required for normal local use.

## Installation

### 1. Download the project

Clone the repository:

```bash
git clone https://github.com/StylishYan/BloxFlip-Modded.git
```

Then enter the project directory:

```bash
cd BloxFlip-MODDED
```

Alternatively, download the repository as a ZIP from GitHub and extract it.

### 2. Start the local server

On Windows, run:

```text
start.bat
```

Or start the Node.js server manually:

```bash
node server.js
```

### 3. Open the website

Open:

```text
http://localhost:3000
```

in your browser.

The application is intended to be accessed through `localhost`.

## Local Accounts

The local build may create account/session/game-state information while you use it.

Runtime data is stored locally and is not supposed to be committed to this repository.

Files such as:

```text
data/state.json
public/local-avatars/
.env
*.log
```

should remain excluded through `.gitignore`.

If you fork or modify the project, make sure you do not accidentally commit personal information, session data, tokens, cookies, credentials, or locally generated account data.

## Virtual Deposits

The Deposit interface in BloxFlip MODDED does **not** perform a real payment.

Entering an amount simply credits virtual **FlipCoins** to the local account.

No Robux purchase, Game Pass purchase, cryptocurrency transfer, card payment, or other real transaction is performed.

## Chat Commands

Some local social/game functionality may be available through the chat.

For example, virtual FlipCoins can be transferred or distributed using supported local commands:
- .tip user amount
- .rain amount

All such transactions only modify the local virtual state and have no real-world value.

## Data and Persistence

The local server may create runtime state after it starts.

This can include:

- local user profiles;
- balances;
- game history;
- chat history;
- local sessions;
- transactions;
- cached avatars;
- game state.

This data is for the local instance only.

If you want a completely fresh installation, stop the server and remove the generated runtime state before starting again.

Do not publish runtime state files to GitHub.

## Security Warning

This project must be treated as a development/entertainment build.

It may lack protections that would be required for a production web application, including but not limited to:

- production-grade authentication;
- hardened session management;
- CSRF protections suitable for Internet deployment;
- abuse prevention;
- production rate limiting;
- production database security;
- secure secrets management;
- infrastructure isolation;
- professional security auditing;
- protection against hostile clients;
- deployment hardening.

Running it locally for entertainment is the intended use case.

**Do not assume that successfully running on localhost means the application is safe to expose publicly.**

## No Real Gambling

BloxFlip MODDED is intended to simulate game interfaces using virtual points.

No real-money wagering is provided by this project.

FlipCoins are fictional points used only by the local application and do not represent money, Robux, cryptocurrency, or any other asset.

## Disclaimer

This is an unofficial fan-made/local modification project.

**BloxFlip MODDED is not the real BloxFlip and is not affiliated with the operators of BloxFlip.**

It does not provide real deposits or withdrawals and does not use real-world currencies, cryptocurrency, Robux, or tradable virtual items as a wagering system.

BloxFlip, Roblox, and other referenced names, trademarks, designs, or assets remain the property of their respective owners.

This repository is provided for local entertainment, experimentation, and technical/educational purposes.

The presence of third-party assets or frontend material in this repository does not grant additional rights to redistribute or commercially use material owned by third parties.

## Contributing

If you modify the project, please keep the local-only concept intact:

- no real-money systems;
- no cryptocurrency deposits or withdrawals;
- no Robux gambling;
- no collection of sensitive credentials;
- no production deployment assumptions;
- no hidden telemetry or tracking.

Bug fixes, local gameplay improvements, missing assets, UI restoration, and compatibility fixes are the intended types of modifications.

## License and Third-Party Material

This repository may contain or reference third-party trademarks, frontend resources, images, sounds, or other assets.

Those materials remain subject to the rights of their respective owners.

Do not assume that an open GitHub repository automatically grants permission to commercially use or redistribute third-party material.

---

**BloxFlip MODDED — local entertainment only. No real deposits. No real withdrawals. No real-world currency.**
