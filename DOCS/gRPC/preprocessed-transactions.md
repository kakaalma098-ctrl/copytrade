> ## Documentation Index
> Fetch the complete documentation index at: https://www.helius.dev/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Preprocessed Transactions (Beta)

> The fastest way to stream Solana transactions.

<Warning>
  **Beta Feature - Request Access Required**

  Preprocessed transactions are currently in beta. To request access, please contact the Helius team via [Telegram](https://t.me/helius_help) or [Discord](https://discord.com/invite/6GXdee3gBj).
</Warning>

<Note>
  **Plan Requirement**: Preprocessed transactions require a **Professional plan** or higher and are metered at the standard LaserStream rate of **2 credits per 0.1 MB**.
</Note>

Preprocessed transactions are the fastest way to receive Solana transactions. Instead of waiting for full transaction processing, LaserStream decodes transactions directly from shreds as they arrive at the validator, giving you access to transaction data milliseconds earlier than standard subscriptions.

This guide explains when to use preprocessed transactions, what data is available, and how to implement them across all LaserStream SDKs.

## What are preprocessed transactions?

In Solana's architecture, transactions flow through several stages before becoming fully processed:

1. **Shred Reception** → Validator receives transaction shreds (data fragments)
2. **Shred Decoding** → Shreds are decoded into raw transactions ← **Preprocessed transactions available here**
3. **Transaction Execution** → Transaction is executed by the runtime
4. **Metadata Generation** → Pre/post balances, logs, and error information are computed
5. **Commitment** → Transaction reaches processed/confirmed/finalized state

Standard transaction subscriptions deliver data at stage 5 - after full execution and metadata generation. Preprocessed subscriptions deliver at stage 2 - immediately after decoding shreds, before execution completes.

**The tradeoff:** You receive transaction data milliseconds earlier, but without execution metadata like balance changes, logs, or error information.

<Tip>
  Need raw Solana shreds? Try [Helius Shred Delivery](/shred-delivery) and [apply for a 2-day trial](https://www.helius.dev/shreds-contact).
</Tip>

## Best-effort Delivery Guarantees

Preprocessed transaction delivery is best-effort, not guaranteed. We target 99.99% delivery rate, but some transactions may be lost during:

* Infrastructure updates and redeployments
* Network issues or validator connectivity problems
* Edge cases in shred decoding or processing

For critical applications requiring guaranteed delivery, use standard [transaction subscriptions](/laserstream/guides/decoding-transaction-data) instead.

## What data is available?

Preprocessed transactions include the complete transaction message but lack execution metadata:

### Available Data

* ✅ **Transaction signature** - Unique transaction identifier
* ✅ **Account keys** - All accounts referenced by the transaction
* ✅ **Instructions** - Complete instruction data and program calls
* ✅ **Recent blockhash** - Transaction expiration reference
* ✅ **Signatures** - All transaction signatures
* ✅ **Is vote transaction** - Whether this is a vote transaction
* ✅ **Slot number** - Which slot contained this transaction

### Missing Data

* ❌ **Transaction metadata** - Token balances changes, pre/post balances, transaction status
* ❌ **Transaction errors** - We cannot determine if the transaction failed
* ❌ **Inner instructions** - Cross-program invocations (CPIs) are not included
* ❌ **Log messages** - Program logs are generated during execution
* ❌ **Compute units consumed** - Execution metrics unavailable

Think of preprocessed transactions as receiving the "proposal" without the "result." You see what the user tried to do, but not what actually happened.

## SDK Support and Version Requirements

Preprocessed transaction subscriptions are supported across all LaserStream SDKs:

<CardGroup cols={3}>
  <Card title="JavaScript/TypeScript" icon="js" href="https://github.com/helius-labs/laserstream-sdk/tree/main/javascript">
    Version **0.2.8** or later
  </Card>

  <Card title="Rust" icon="rust" href="https://github.com/helius-labs/laserstream-sdk/tree/main/rust">
    Version **0.1.5** or later
  </Card>

  <Card title="Go" icon="golang" href="https://github.com/helius-labs/laserstream-sdk/tree/main/go">
    Version **0.1.0** or later
  </Card>
</CardGroup>

***

## Implementation Examples

### JavaScript/TypeScript

The JavaScript SDK provides a dedicated `subscribePreprocessed` function with automatic reconnection:

```typescript [expandable] theme={"system"}
import {
  subscribePreprocessed,
  CommitmentLevel,
  LaserstreamConfig,
  SubscribePreprocessedRequest,
  SubscribePreprocessedUpdate
} from 'helius-laserstream';
import bs58 from 'bs58';

async function streamPreprocessedTransactions() {
  const config: LaserstreamConfig = {
    apiKey: 'YOUR_API_KEY',
    endpoint: 'https://laserstream-mainnet-ewr.helius-rpc.com',
  };

  const request: SubscribePreprocessedRequest = {
    transactions: {
      "jupiter-swaps": {
        vote: false,
        accountInclude: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']
      }
    }
  };

  const stream = await subscribePreprocessed(
    config,
    request,
    async (update: SubscribePreprocessedUpdate) => {
      if (update.transaction) {
        const tx = update.transaction;
        const signature = bs58.encode(tx.transaction.signature);

        console.log('⚡ Preprocessed transaction received:');
        console.log(`  Signature: ${signature}`);
        console.log(`  Slot: ${tx.slot}`);
        console.log(`  Is Vote: ${tx.transaction.isVote}`);
        console.log(`  Filters: ${update.filters.join(', ')}`);
        console.log('---');
      }
    },
    async (error) => {
      console.error('Stream error:', error);
    }
  );

  console.log(`✅ Preprocessed stream started (id: ${stream.id})`);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down stream...');
    stream.cancel();
    process.exit(0);
  });
}

streamPreprocessedTransactions().catch(console.error);
```

**Full example:** [preprocessed-transaction-sub.ts](https://github.com/helius-labs/laserstream-sdk/blob/main/javascript/examples/preprocessed-transaction-sub.ts)

### Rust

The Rust SDK provides native performance:

```rust [expandable] theme={"system"}
use futures::StreamExt;
use helius_laserstream::{
    grpc::{SubscribePreprocessedRequest, SubscribePreprocessedRequestFilterTransactions},
    subscribe_preprocessed, LaserstreamConfig,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = LaserstreamConfig {
        endpoint: "https://laserstream-mainnet-ewr.helius-rpc.com".to_string(),
        api_key: "YOUR_API_KEY".to_string(),
        ..Default::default()
    };

    let mut request = SubscribePreprocessedRequest::default();
    request.transactions.insert(
        "jupiter-swaps".to_string(),
        SubscribePreprocessedRequestFilterTransactions {
            vote: Some(false),
            account_include: vec![
                "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4".to_string()
            ],
            ..Default::default()
        },
    );

    let (stream, _handle) = subscribe_preprocessed(config, request);
    tokio::pin!(stream);

    println!("✅ Preprocessed stream started");

    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                if let Some(tx) = update.transaction {
                    println!("⚡ Preprocessed transaction:");
                    println!("  Slot: {}", tx.slot);
                    println!("  Is Vote: {}", tx.transaction.is_vote);
                    println!("---");
                }
            }
            Err(e) => {
                eprintln!("Stream error: {:?}", e);
                break;
            }
        }
    }

    Ok(())
}
```

**Full example:** [preprocessed\_transaction\_sub.rs](https://github.com/helius-labs/laserstream-sdk/blob/main/rust/examples/preprocessed_transaction_sub.rs)

### Go

The Go SDK provides idiomatic Go interfaces:

```go [expandable] theme={"system"}
package main

import (
    "log"
    "os"
    "os/signal"
    "syscall"

    laserstream "github.com/helius-labs/laserstream-sdk/go"
    pb "github.com/helius-labs/laserstream-sdk/go/proto"
)

func main() {
    log.SetFlags(0)

    clientConfig := laserstream.LaserstreamConfig{
        Endpoint: "https://laserstream-mainnet-ewr.helius-rpc.com",
        APIKey:   "YOUR_API_KEY",
    }

    voteFilter := false
    subscriptionRequest := &pb.SubscribePreprocessedRequest{
        Transactions: map[string]*pb.SubscribePreprocessedRequestFilterTransactions{
            "jupiter-swaps": {
                Vote: &voteFilter,
                AccountInclude: []string{
                    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
                },
            },
        },
    }

    client := laserstream.NewPreprocessedClient(clientConfig)

    dataCallback := func(data *pb.SubscribePreprocessedUpdate) {
        if data.Transaction != nil {
            log.Println("⚡ Preprocessed transaction:")
            log.Printf("  Slot: %d\n", data.Transaction.Slot)
            log.Printf("  Is Vote: %t\n", data.Transaction.Transaction.IsVote)
            log.Println("---")
        }
    }

    errorCallback := func(err error) {
        log.Printf("Error: %v", err)
    }

    err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
    if err != nil {
        log.Fatalf("Failed to subscribe: %v", err)
    }

    log.Println("✅ Preprocessed stream started")
    log.Println("Press Ctrl+C to exit")

    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    log.Println("\nShutting down...")
    client.Close()
}
```

**Full example:** [preprocessed-transaction-sub.go](https://github.com/helius-labs/laserstream-sdk/blob/main/go/examples/preprocessed-transaction-sub.go)

***

## Subscription Structure and Filtering

### Request Structure

The preprocessed subscription request follows a similar structure to standard subscriptions but with a focused set of filters:

```typescript theme={"system"}
interface SubscribePreprocessedRequest {
  transactions: {
    [filterName: string]: SubscribePreprocessedRequestFilterTransactions
  };
  ping?: SubscribeRequestPing;
}

interface SubscribePreprocessedRequestFilterTransactions {
  vote?: boolean;              // Include/exclude vote transactions
  signature?: string;          // Filter by specific transaction signature
  accountInclude?: string[];   // Include transactions touching these accounts
  accountExclude?: string[];   // Exclude transactions touching these accounts
  accountRequired?: string[];  // Require all these accounts to be present
}
```

### Response Structure

Updates arrive with the complete transaction message and basic metadata:

```typescript theme={"system"}
interface SubscribePreprocessedUpdate {
  filters: string[];                             // Which filters matched
  transaction?: SubscribePreprocessedTransaction; // The transaction data
  ping?: SubscribeUpdatePing;                    // Keepalive ping
  pong?: SubscribeUpdatePong;                    // Ping response
  createdAt: Date;                               // When update was created
}

interface SubscribePreprocessedTransaction {
  transaction: SubscribePreprocessedTransactionInfo;
  slot: number;                                  // Slot containing transaction
}

interface SubscribePreprocessedTransactionInfo {
  signature: Uint8Array;                         // Transaction signature
  isVote: boolean;                               // Is this a vote transaction
  transaction: solana.storage.Transaction;       // Full transaction message
}
```

The `transaction.transaction` field contains the complete Solana transaction structure including:

* **Message** - Account keys, instructions, recent blockhash
* **Signatures** - All transaction signatures
* **Address table lookups** - For versioned transactions

This is identical to the transaction structure in standard subscriptions, but without the `meta` field containing execution results.
