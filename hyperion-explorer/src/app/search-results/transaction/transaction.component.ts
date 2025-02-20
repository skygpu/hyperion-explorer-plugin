import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AccountService } from '../../services/account.service';
import { faExchangeAlt } from '@fortawesome/free-solid-svg-icons/faExchangeAlt';
import { faCircle } from '@fortawesome/free-solid-svg-icons/faCircle';
import { faLock } from '@fortawesome/free-solid-svg-icons/faLock';
import { faHourglassStart } from '@fortawesome/free-solid-svg-icons/faHourglassStart';
import { faHistory } from '@fortawesome/free-solid-svg-icons/faHistory';
import { faSadTear } from '@fortawesome/free-solid-svg-icons/faSadTear';
import { faSpinner } from '@fortawesome/free-solid-svg-icons/faSpinner';
import { ChainService } from '../../services/chain.service';
import { Title } from '@angular/platform-browser';
import { environment } from '../../../environments/environment';
import { imageExists } from 'src/utils';

@Component({
  selector: 'app-transaction',
  templateUrl: './transaction.component.html',
  styleUrls: ['./transaction.component.css']
})
export class TransactionComponent implements OnInit, OnDestroy {
  columnsToDisplay: string[] = ['contract', 'action', 'data', 'auth'];
  tx: any = {
    actions: null
  };
  faCircle = faCircle;
  faExchange = faExchangeAlt;
  faLock = faLock;
  faHourglass = faHourglassStart;
  faHistory = faHistory;
  faSadTear = faSadTear;
  faSpinner = faSpinner;
  txID: string;
  countdownLoop: any;
  countdownTimer = 0;
  ipfsImageUrl: string;
  ipfsInputImageUrl: string;
  inputTxUrl: string;
  inputTxText: string;
  hasImage: boolean
  hasInputImage: boolean

  objectKeyCount(obj): number {
    try {
      return Object.keys(obj).length;
    } catch (e) {
      return 0;
    }
  }

  constructor(private activatedRoute: ActivatedRoute,
    public accountService: AccountService,
    public chainData: ChainService,
    private title: Title) {
  }

  openImage() {
    window.open(this.ipfsImageUrl, '_blank');
  }

  openInputImage() {
    window.open(this.ipfsInputImageUrl, '_blank');
  }

  getPrettyJson(value: any){
    return JSON.stringify(JSON.parse(value), null, 2)
  }

  ngOnInit(): void {
    this.activatedRoute.params.subscribe(async (routeParams) => {
      // std hyperion tx init
      this.txID = routeParams.transaction_id;
      this.tx = await this.accountService.loadTxData(routeParams.transaction_id);

      this.accountService.libNum = this.tx.lib;
      if (this.tx.actions[0].block_num > this.tx.lib) {
        await this.reloadCountdownTimer();
        this.countdownLoop = setInterval(async () => {
          this.countdownTimer--;
          if (this.countdownTimer <= 0) {
            await this.reloadCountdownTimer();
            if (this.accountService.libNum > this.tx.actions[0].block_num) {
              clearInterval(this.countdownLoop);
            }
          }
        }, 1000);
      }

      if (!this.chainData.chainInfoData.chain_name) {
        this.title.setTitle(`TX ${routeParams.transaction_id.slice(0, 8)} • Hyperion Explorer`);
      } else {
        this.title.setTitle(`TX ${routeParams.transaction_id.slice(0, 8)} • ${this.chainData.chainInfoData.chain_name} Hyperion Explorer`);
      }

      // custom skynet logic

      let submitAction = this.tx.actions.find(a =>
        a.act.account == environment.gpuContract
        &&
        a.act.name == 'submit'
      );

      if (submitAction === undefined)
        return;

      // handle result img
      this.hasImage = false;
      const resultCID = submitAction.act.data.ipfs_hash;
      if (resultCID) {
        const link = `${environment.ipfsUrl}${resultCID}`;
        if (await imageExists(link)) {
          this.ipfsImageUrl = `${environment.thumborUrl}/unsafe/512x512/${encodeURIComponent(link)}`;
          this.hasImage = true;
        }
      }

      // maybe find a matching enqueue tx
      let inputTxId;
      if (environment.protocolVersion == 0) {
        inputTxId = await this.findEnqueueTXId(routeParams.transaction_id);
      } else {
        inputTxId = await this.findEnqueueTXIdV1(routeParams.transaction_id);
      }

      if (inputTxId === undefined) {
        console.error('couldnt find enqueue tx');
        return;
      }

      const inputTx = await this.accountService.loadTxData(inputTxId);

      let enqueueAction = inputTx.actions.find(a =>
        a.act.account == environment.gpuContract
        &&
        a.act.name == 'enqueue'
      );

      if (enqueueAction === undefined) {
        console.error('couldnt find enqueue action');
        return;
      }

      const enqueueData = enqueueAction.act.data;
      const request = JSON.parse(enqueueData.request_body);

      this.inputTxText = request.params.prompt;
      this.inputTxUrl = `${environment.hyperionApiUrl}/v2/explore/transaction/${inputTxId};`
      this.hasInputImage = false;

      // handle binary inputs to the submit
      // TODO: only displays first input
      if (enqueueData.binary_data) {
        const inputs = enqueueData.binary_data.split(',');

        if (inputs.length > 0) {
          const link = `${environment.ipfsUrl}${inputs[0]}`;
          if (await imageExists(link)) {
            this.ipfsInputImageUrl = `${environment.thumborUrl}/unsafe/512x512/${encodeURIComponent(link)}`;
            this.hasInputImage = true;
          }
        }
      }
    });
  }


  async hashRequest(data) {
    // Combine all parts of the data into a single string.
    const combinedData = `${data.nonce}${data.body}${data.binary_data}`;

    // Encode combinedData to UTF-8 and hash it.
    const encodedData = new TextEncoder().encode(combinedData);
    const hash = await window.crypto.subtle.digest('SHA-256', encodedData);

    // Convert the hash (a byte array) to a hexadecimal string and uppercase it.
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  async fetchTransaction(txId: string) {
    try {
      const response = await fetch(`${environment.hyperionApiUrl}/v2/history/get_transaction?id=${txId}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error:', error);
    }
  }

  async findEnqueueTXIdV1(submitTx: string) {

    const submitData = await this.fetchTransaction(submitTx);
    const submitAction = submitData.actions[0];

    const requestId = submitAction.act.data.request_id;

    let startDate = new Date(submitAction.timestamp + 'Z');
    startDate.setSeconds(startDate.getSeconds() - 1);

    console.log(requestId, startDate);

    const msInAnHour = 60 * 60 * 1000; // milliseconds in an hour
    const maxRequests = 3;

    let before = startDate.getTime(); // convert startDate to ms since epoch
    let after = before - msInAnHour;

    for (let requestCounter = 0; requestCounter < maxRequests; requestCounter++) {
      try {

        const params = new URLSearchParams({
            code: environment.gpuContract,
            scope: environment.gpuContract,
            table: "queue",
            sort: "desc",
            before: new Date(before).toISOString(),
            after: new Date(after).toISOString(),
        });

        const url = `${environment.hyperionApiUrl}/v2/history/get_deltas?${params.toString()}`;
        const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();

        let matchDelta = null;

        // Find a delta with a matching hash using for-of loop.
        for (const delta of data.deltas) {
          if (delta.data.request_id === requestId) {
            matchDelta = delta;
            break;
          }
        }

        if (!matchDelta) {
          before -= msInAnHour;
          after -= msInAnHour;
          continue;
        }

        const matchBlock = await this.accountService.loadBlockDataByNumber(matchDelta.block_num);

        // Find the enqueue within the block

        for (const tx of matchBlock.transactions) {
          for (const action of tx.trx.transaction.actions) {
            if (action.data.request_id == requestId)
              return tx.trx.id;
          }
        }
      } catch (error) {
        console.error('Error:', error);
        break;
      }
    }
  }

  async findEnqueueTXId(submitTx: string) {

    const submitData = await this.fetchTransaction(submitTx);
    const submitAction = submitData.actions[0];

    const requestHash = submitAction.act.data.request_hash;

    let startDate = new Date(submitAction.timestamp + 'Z');
    startDate.setSeconds(startDate.getSeconds() - 1);

    console.log(requestHash, startDate);

    const msInAnHour = 60 * 60 * 1000; // milliseconds in an hour
    const maxRequests = 3;

    let before = startDate.getTime(); // convert startDate to ms since epoch
    let after = before - msInAnHour;

    for (let requestCounter = 0; requestCounter < maxRequests; requestCounter++) {
      try {
        const params = new URLSearchParams({
            code: environment.gpuContract,
            scope: environment.gpuContract,
            table: "queue",
            sort: "desc",
            before: new Date(before).toISOString(),
            after: new Date(after).toISOString(),
        });

        const url = `${environment.hyperionApiUrl}/v2/history/get_deltas?${params.toString()}`;
        const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();

        let matchDelta = null;

        // Find a delta with a matching hash using for-of loop.
        for (const delta of data.deltas) {
          const hash = await this.hashRequest(delta.data);
          if (hash === requestHash) {
            matchDelta = delta;
            break;
          }
        }

        if (!matchDelta) {
          before -= msInAnHour;
          after -= msInAnHour;
          continue;
        }

        const matchBlock = await this.accountService.loadBlockDataByNumber(matchDelta.block_num);
        const nonces = await this.accountService.getBlockNonces(matchBlock.timestamp);

        // Find a transaction with a matching hash.

        for (const tx of matchBlock.transactions) {
          for (const action of tx.trx.transaction.actions) {
            let foundNonce = null;
            // Find nonce with matching hash using for-of loop.
            for (const n of nonces) {
              const hash = await this.hashRequest({
                nonce: (parseInt(n) - 1).toString(),
                body: action.data.request_body,
                binary_data: action.data.binary_data
              });

              if (hash === requestHash) {
                foundNonce = n;
                break;
              }
            }
            console.log(foundNonce);
            if (foundNonce) return tx.trx.id;
          }
        }
      } catch (error) {
        console.error('Error:', error);
        break;
      }
    }
  }

  ngOnDestroy(): void {
    if (this.countdownLoop) {
      clearInterval(this.countdownLoop);
    }
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleString();
  }

  async reloadCountdownTimer(): Promise<void> {
    await this.accountService.updateLib();
    this.countdownTimer = Math.ceil((this.tx.actions[0].block_num - this.accountService.libNum) / 2);
  }
}
