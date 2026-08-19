/**
 * ABI slices generated from the compiled contracts.
 *
 * Regenerate with scripts/generate-abi.mjs whenever the contracts change; a
 * stale ABI here means silently encoding the wrong calldata.
 */

export const FLOW_REGISTRY_ABI = [
  {
    "type": "function",
    "name": "executorOf",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "flowOf",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isPublished",
    "inputs": [
      {
        "name": "flowId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "publishFlow",
    "inputs": [
      {
        "name": "flowId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "specRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "runs",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "flowId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "executor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "startedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "startRun",
    "inputs": [
      {
        "name": "flowId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "executor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
] as const;

export const EXECUTION_RECEIPTS_ABI = [
  {
    "type": "function",
    "name": "anchorStep",
    "inputs": [
      {
        "name": "r",
        "type": "tuple",
        "internalType": "struct ExecutionReceipts.Receipt",
        "components": [
          {
            "name": "flowId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "runId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "stepIndex",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "agentId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "inputHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "outputHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "traceRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "attestationRef",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "startedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "endedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "anchoredCount",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAnchored",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "stepIndex",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isSealed",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sealOf",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "chainRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "stepCount",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "sealedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sealRun",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "chainRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "stepCount",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "statusOf",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "stepIndex",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "RunSealed",
    "inputs": [
      {
        "name": "runId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "chainRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "stepCount",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "StepAnchored",
    "inputs": [
      {
        "name": "flowId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "runId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "stepIndex",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "agentId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "inputHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "outputHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "traceRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "attestationRef",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "startedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "endedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "status",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  }
] as const;
