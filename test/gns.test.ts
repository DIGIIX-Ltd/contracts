import { expect } from 'chai'
import { ethers, ContractTransaction, BigNumber, Event } from 'ethers'
import { Interface, solidityKeccak256 } from 'ethers/lib/utils'
import { SubgraphDeploymentID } from '@graphprotocol/common-ts'

import { LegacyGNSMock } from '../build/types/LegacyGNSMock'
import { GraphToken } from '../build/types/GraphToken'
import { Curation } from '../build/types/Curation'
import { SubgraphNFT } from '../build/types/SubgraphNFT'

import {
  getAccounts,
  randomHexBytes,
  Account,
  toGRT,
  getChainID,
  latestBlock,
  advanceBlocks,
  advanceBlock,
} from './lib/testHelpers'
import { NetworkFixture } from './lib/fixtures'
import { toBN, formatGRT } from './lib/testHelpers'
import { getContractAt } from '../cli/network'
import { deployContract } from './lib/deployment'
import { BancorFormula } from '../build/types/BancorFormula'
import { network } from '../cli'
import { Controller } from '../build/types/Controller'
import { GraphProxyAdmin } from '../build/types/GraphProxyAdmin'
import { L1GNS } from '../build/types/L1GNS'
import path from 'path'
import { Artifacts } from 'hardhat/internal/artifacts'
import { L1GraphTokenGateway } from '../build/types/L1GraphTokenGateway'

const { AddressZero, HashZero } = ethers.constants

const ARTIFACTS_PATH = path.resolve('build/contracts')
const artifacts = new Artifacts(ARTIFACTS_PATH)
const l2GNSabi = artifacts.readArtifactSync('L2GNS').abi
const l2GNSIface = new Interface(l2GNSabi)

// Entities
interface PublishSubgraph {
  subgraphDeploymentID: string
  versionMetadata: string
  subgraphMetadata: string
}

interface Subgraph {
  vSignal: BigNumber
  nSignal: BigNumber
  subgraphDeploymentID: string
  reserveRatio: number
  disabled: boolean
  withdrawableGRT: BigNumber
  id?: string
}

interface AccountDefaultName {
  name: string
  nameIdentifier: string
}

// Utils

const DEFAULT_RESERVE_RATIO = 1000000
const toFloat = (n: BigNumber) => parseFloat(formatGRT(n))
const toRound = (n: number) => n.toFixed(12)
const buildSubgraphID = async (account: string, seqID: BigNumber): Promise<string> =>
  solidityKeccak256(['address', 'uint256', 'uint256'], [account, seqID, await getChainID()])

const buildLegacySubgraphID = (account: string, seqID: BigNumber): string =>
  solidityKeccak256(['address', 'uint256'], [account, seqID])

describe('L1GNS', () => {
  let me: Account
  let other: Account
  let another: Account
  let governor: Account
  let mockRouter: Account
  let mockL2GRT: Account
  let mockL2Gateway: Account
  let mockL2GNS: Account

  let fixture: NetworkFixture

  let gns: L1GNS
  let legacyGNSMock: LegacyGNSMock
  let grt: GraphToken
  let curation: Curation
  let controller: Controller
  let proxyAdmin: GraphProxyAdmin
  let l1GraphTokenGateway: L1GraphTokenGateway

  const tokens1000 = toGRT('1000')
  const tokens10000 = toGRT('10000')
  const tokens100000 = toGRT('100000')
  const curationTaxPercentage = 50000

  let newSubgraph0: PublishSubgraph
  let newSubgraph1: PublishSubgraph
  let defaultName: AccountDefaultName

  const buildSubgraph = (): PublishSubgraph => {
    return {
      subgraphDeploymentID: randomHexBytes(),
      versionMetadata: randomHexBytes(),
      subgraphMetadata: randomHexBytes(),
    }
  }

  const createDefaultName = (name: string): AccountDefaultName => {
    return {
      name: name,
      nameIdentifier: ethers.utils.namehash(name),
    }
  }

  const getTokensAndVSignal = async (subgraphDeploymentID: string): Promise<Array<BigNumber>> => {
    const curationPool = await curation.pools(subgraphDeploymentID)
    const vSignal = await curation.getCurationPoolSignal(subgraphDeploymentID)
    return [curationPool.tokens, vSignal]
  }

  async function calcGNSBondingCurve(
    gnsSupply: BigNumber, // nSignal
    gnsReserveBalance: BigNumber, // vSignal
    gnsReserveRatio: number, // default reserve ratio of GNS
    depositAmount: BigNumber, // GRT deposited
    subgraphID: string,
  ): Promise<number> {
    const signal = await curation.getCurationPoolSignal(subgraphID)
    const curationTokens = await curation.getCurationPoolTokens(subgraphID)
    const curationReserveRatio = await curation.defaultReserveRatio()
    const expectedSignal = await calcCurationBondingCurve(
      signal,
      curationTokens,
      curationReserveRatio,
      depositAmount,
    )
    const expectedSignalBN = toGRT(String(expectedSignal.toFixed(18)))

    // Handle the initialization of the bonding curve
    if (gnsSupply.eq(0)) {
      return expectedSignal
    }
    // Since we known CW = 1, we can do the simplified formula of:
    return (toFloat(gnsSupply) * toFloat(expectedSignalBN)) / toFloat(gnsReserveBalance)
  }

  async function calcCurationBondingCurve(
    supply: BigNumber,
    reserveBalance: BigNumber,
    reserveRatio: number,
    depositAmount: BigNumber,
  ): Promise<number> {
    // Handle the initialization of the bonding curve
    const minSupply = toGRT('1')
    if (supply.eq(0)) {
      const minDeposit = await curation.minimumCurationDeposit()
      if (depositAmount.lt(minDeposit)) {
        throw new Error('deposit must be above minimum')
      }
      return (
        (await calcCurationBondingCurve(
          minSupply,
          minDeposit,
          reserveRatio,
          depositAmount.sub(minDeposit),
        )) + toFloat(minSupply)
      )
    }
    // Calculate bonding curve in the test
    return (
      toFloat(supply) *
      ((1 + toFloat(depositAmount) / toFloat(reserveBalance)) ** (reserveRatio / 1000000) - 1)
    )
  }

  const publishNewSubgraph = async (
    account: Account,
    newSubgraph: PublishSubgraph, // Defaults to subgraph created in before()
  ): Promise<Subgraph> => {
    const subgraphID = await buildSubgraphID(
      account.address,
      await gns.nextAccountSeqID(account.address),
    )

    // Send tx
    const tx = gns
      .connect(account.signer)
      .publishNewSubgraph(
        newSubgraph.subgraphDeploymentID,
        newSubgraph.versionMetadata,
        newSubgraph.subgraphMetadata,
      )

    // Check events
    await expect(tx)
      .emit(gns, 'SubgraphPublished')
      .withArgs(subgraphID, newSubgraph.subgraphDeploymentID, DEFAULT_RESERVE_RATIO)
      .emit(gns, 'SubgraphMetadataUpdated')
      .withArgs(subgraphID, newSubgraph.subgraphMetadata)
      .emit(gns, 'SubgraphVersionUpdated')
      .withArgs(subgraphID, newSubgraph.subgraphDeploymentID, newSubgraph.versionMetadata)

    // Check state
    const subgraph = await gns.subgraphs(subgraphID)
    expect(subgraph.vSignal).eq(0)
    expect(subgraph.nSignal).eq(0)
    expect(subgraph.subgraphDeploymentID).eq(newSubgraph.subgraphDeploymentID)
    expect(subgraph.reserveRatio).eq(DEFAULT_RESERVE_RATIO)
    expect(subgraph.disabled).eq(false)
    expect(subgraph.withdrawableGRT).eq(0)

    // Check NFT issuance
    const owner = await gns.ownerOf(subgraphID)
    expect(owner).eq(account.address)

    return { ...subgraph, id: subgraphID }
  }

  const publishNewVersion = async (
    account: Account,
    subgraphID: string,
    newSubgraph: PublishSubgraph,
  ) => {
    // Before state
    const ownerTaxPercentage = await gns.ownerTaxPercentage()
    const curationTaxPercentage = await curation.curationTaxPercentage()
    const beforeSubgraph = await gns.subgraphs(subgraphID)

    // Check what selling all nSignal, which == selling all vSignal, should return for tokens
    // NOTE - no tax on burning on nSignal
    const tokensReceivedEstimate = beforeSubgraph.nSignal.gt(0)
      ? (await gns.nSignalToTokens(subgraphID, beforeSubgraph.nSignal))[1]
      : toBN(0)
    // Example:
    // Deposit 100, 5 is taxed, 95 GRT in curve
    // Upgrade - calculate 5% tax on 95 --> 4.75 GRT
    // Multiple by ownerPercentage --> 50% * 4.75 = 2.375 GRT
    // Owner adds 2.375 to 90.25, we deposit 92.625 GRT into the curve
    // Divide this by 0.95 to get exactly 97.5 total tokens to be deposited

    // nSignalToTokens returns the amount of tokens with tax removed
    // already. So we must add in the tokens removed
    const MAX_PPM = 1000000
    const taxOnOriginal = tokensReceivedEstimate.mul(curationTaxPercentage).div(MAX_PPM)
    const totalWithoutOwnerTax = tokensReceivedEstimate.sub(taxOnOriginal)
    const ownerTax = taxOnOriginal.mul(ownerTaxPercentage).div(MAX_PPM)
    const totalWithOwnerTax = totalWithoutOwnerTax.add(ownerTax)
    const totalAdjustedUp = totalWithOwnerTax.mul(MAX_PPM).div(MAX_PPM - curationTaxPercentage)

    // Re-estimate amount of signal to get considering the owner tax paid by the owner

    const { 0: newVSignalEstimate, 1: newCurationTaxEstimate } = beforeSubgraph.nSignal.gt(0)
      ? await curation.tokensToSignal(newSubgraph.subgraphDeploymentID, totalAdjustedUp)
      : [toBN(0), toBN(0)]

    // Send tx
    const tx = gns
      .connect(account.signer)
      .publishNewVersion(subgraphID, newSubgraph.subgraphDeploymentID, newSubgraph.versionMetadata)
    const txResult = expect(tx)
      .emit(gns, 'SubgraphVersionUpdated')
      .withArgs(subgraphID, newSubgraph.subgraphDeploymentID, newSubgraph.versionMetadata)

    // Only emits this event if there was actual signal to upgrade
    if (beforeSubgraph.nSignal.gt(0)) {
      txResult
        .emit(gns, 'SubgraphUpgraded')
        .withArgs(subgraphID, newVSignalEstimate, totalAdjustedUp, newSubgraph.subgraphDeploymentID)
    }
    await txResult

    // Check curation vSignal old are set to zero
    const [afterTokensOldCuration, afterVSignalOldCuration] = await getTokensAndVSignal(
      beforeSubgraph.subgraphDeploymentID,
    )
    expect(afterTokensOldCuration).eq(0)
    expect(afterVSignalOldCuration).eq(0)

    // Check the vSignal of the new curation curve, and tokens
    const [afterTokensNewCurve, afterVSignalNewCurve] = await getTokensAndVSignal(
      newSubgraph.subgraphDeploymentID,
    )
    expect(afterTokensNewCurve).eq(totalAdjustedUp.sub(newCurationTaxEstimate))
    expect(afterVSignalNewCurve).eq(newVSignalEstimate)

    // Check the nSignal pool
    const afterSubgraph = await gns.subgraphs(subgraphID)
    expect(afterSubgraph.vSignal).eq(afterVSignalNewCurve).eq(newVSignalEstimate)
    expect(afterSubgraph.nSignal).eq(beforeSubgraph.nSignal) // should not change
    expect(afterSubgraph.subgraphDeploymentID).eq(newSubgraph.subgraphDeploymentID)

    // Check NFT should not change owner
    const owner = await gns.ownerOf(subgraphID)
    expect(owner).eq(account.address)

    return tx
  }

  const deprecateSubgraph = async (account: Account, subgraphID: string) => {
    // Before state
    const beforeSubgraph = await gns.subgraphs(subgraphID)
    const [beforeTokens] = await getTokensAndVSignal(beforeSubgraph.subgraphDeploymentID)

    // We can use the whole amount, since in this test suite all vSignal is used to be staked on nSignal
    const ownerBalanceBefore = await grt.balanceOf(account.address)

    // Send tx
    const tx = gns.connect(account.signer).deprecateSubgraph(subgraphID)
    await expect(tx).emit(gns, 'SubgraphDeprecated').withArgs(subgraphID, beforeTokens)

    // After state
    const afterSubgraph = await gns.subgraphs(subgraphID)
    // Check marked as deprecated
    expect(afterSubgraph.disabled).eq(true)
    // Signal for the deployment must be all burned
    expect(afterSubgraph.vSignal.eq(toBN('0')))
    // Cleanup reserve ratio
    expect(afterSubgraph.reserveRatio).eq(0)
    // Should be equal since owner pays curation tax
    expect(afterSubgraph.withdrawableGRT).eq(beforeTokens)

    // Check balance of GNS increased by curation tax from owner being added
    const afterGNSBalance = await grt.balanceOf(gns.address)
    expect(afterGNSBalance).eq(afterSubgraph.withdrawableGRT)
    // Check that the owner balance decreased by the curation tax
    const ownerBalanceAfter = await grt.balanceOf(account.address)
    expect(ownerBalanceBefore.eq(ownerBalanceAfter))

    // Check NFT was burned
    await expect(gns.ownerOf(subgraphID)).revertedWith('ERC721: owner query for nonexistent token')

    return tx
  }

  /*
  const upgradeNameSignal = async (
    account: Account,
    graphAccount: string,
    subgraphNumber0: number,
    newSubgraphDeplyomentID: string,
  ): Promise<ContractTransaction> => {
    // Before stats for the old vSignal curve
    const beforeTokensVSigOldCuration = await getTokensAndVSignal(subgraph0.subgraphDeploymentID)
    const beforeTokensOldCuration = beforeTokensVSigOldCuration[0]
    const beforeVSignalOldCuration = beforeTokensVSigOldCuration[1]

    // Before stats for the name curve
    const poolBefore = await gns.nameSignals(graphAccount, subgraphNumber0)
    const nSigBefore = poolBefore[1]

    // Check what selling all nSignal, which == selling all vSignal, should return for tokens
    const nSignalToTokensResult = await gns.nSignalToTokens(
      graphAccount,
      subgraphNumber0,
      nSigBefore,
    )
    const vSignalBurnEstimate = nSignalToTokensResult[0]
    const tokensReceivedEstimate = nSignalToTokensResult[1]

    // since in upgrade, owner must refund fees, we need to actually add this back in
    const feesToAddBackEstimate = nSignalToTokensResult[2]
    const upgradeTokenReturn = tokensReceivedEstimate.add(feesToAddBackEstimate)

    // Get the value for new vSignal that should be created on the new curve
    const newVSignalEstimate = await curation.tokensToSignal(
      newSubgraphDeplyomentID,
      upgradeTokenReturn,
    )

    // Do the upgrade
    const tx = gns
      .connect(account.signer)
      .upgradeNameSignal(graphAccount, subgraphNumber0, newSubgraphDeplyomentID)
    await expect(tx)
      .emit(gns, 'NameSignalUpgrade')
      .withArgs(
        graphAccount,
        subgraphNumber0,
        newVSignalEstimate,
        upgradeTokenReturn,
        newSubgraphDeplyomentID,
      )

    // Check curation vSignal old was lowered and tokens too
    const [afterTokensOldCuration, vSigAfterOldCuration] = await getTokensAndVSignal(
      subgraph0.subgraphDeploymentID,
    )
    expect(afterTokensOldCuration).eq(beforeTokensOldCuration.sub(upgradeTokenReturn))
    expect(vSigAfterOldCuration).eq(beforeVSignalOldCuration.sub(vSignalBurnEstimate))

    // Check the vSignal of the new curation curve, amd tokens
    const [afterTokensNewCurve, vSigAfterNewCurve] = await getTokensAndVSignal(
      newSubgraphDeplyomentID,
    )
    expect(afterTokensNewCurve).eq(upgradeTokenReturn)
    expect(vSigAfterNewCurve).eq(newVSignalEstimate)

    // Check the nSignal pool
    const pool = await gns.nameSignals(graphAccount, subgraphNumber0)
    const vSigPool = pool[0]
    const nSigAfter = pool[1]
    const deploymentID = pool[2]
    expect(vSigAfterNewCurve).eq(vSigPool).eq(newVSignalEstimate)
    expect(nSigBefore).eq(nSigAfter) // should not change
    expect(deploymentID).eq(newSubgraphDeplyomentID)

    return tx
  }
  */

  const mintSignal = async (
    account: Account,
    subgraphID: string,
    tokensIn: BigNumber,
  ): Promise<ContractTransaction> => {
    // Before state
    const beforeSubgraph = await gns.subgraphs(subgraphID)
    const [beforeTokens, beforeVSignal] = await getTokensAndVSignal(
      beforeSubgraph.subgraphDeploymentID,
    )

    // Deposit
    const {
      0: vSignalExpected,
      1: nSignalExpected,
      2: curationTax,
    } = await gns.tokensToNSignal(subgraphID, tokensIn)
    const tx = gns.connect(account.signer).mintSignal(subgraphID, tokensIn, 0)
    await expect(tx)
      .emit(gns, 'SignalMinted')
      .withArgs(subgraphID, account.address, nSignalExpected, vSignalExpected, tokensIn)

    // After state
    const afterSubgraph = await gns.subgraphs(subgraphID)
    const [afterTokens, afterVSignal] = await getTokensAndVSignal(
      afterSubgraph.subgraphDeploymentID,
    )

    // Check state
    expect(afterTokens).eq(beforeTokens.add(tokensIn.sub(curationTax)))
    expect(afterVSignal).eq(beforeVSignal.add(vSignalExpected))
    expect(afterSubgraph.nSignal).eq(beforeSubgraph.nSignal.add(nSignalExpected))
    expect(afterSubgraph.vSignal).eq(beforeVSignal.add(vSignalExpected))

    return tx
  }

  const burnSignal = async (account: Account, subgraphID: string): Promise<ContractTransaction> => {
    // Before state
    const beforeSubgraph = await gns.subgraphs(subgraphID)
    const [beforeTokens, beforeVSignal] = await getTokensAndVSignal(
      beforeSubgraph.subgraphDeploymentID,
    )
    const beforeUsersNSignal = await gns.getCuratorSignal(subgraphID, account.address)

    // Withdraw
    const { 0: vSignalExpected, 1: tokensExpected } = await gns.nSignalToTokens(
      subgraphID,
      beforeUsersNSignal,
    )

    // Send tx
    const tx = gns.connect(account.signer).burnSignal(subgraphID, beforeUsersNSignal, 0)
    await expect(tx)
      .emit(gns, 'SignalBurned')
      .withArgs(subgraphID, account.address, beforeUsersNSignal, vSignalExpected, tokensExpected)

    // After state
    const afterSubgraph = await gns.subgraphs(subgraphID)
    const [afterTokens, afterVSignalCuration] = await getTokensAndVSignal(
      afterSubgraph.subgraphDeploymentID,
    )

    // Check state
    expect(afterTokens).eq(beforeTokens.sub(tokensExpected))
    expect(afterVSignalCuration).eq(beforeVSignal.sub(vSignalExpected))
    expect(afterSubgraph.nSignal).eq(beforeSubgraph.nSignal.sub(beforeUsersNSignal))

    return tx
  }

  const transferSignal = async (
    subgraphID: string,
    owner: Account,
    recipient: Account,
    amount: BigNumber,
  ): Promise<ContractTransaction> => {
    // Before state
    const beforeOwnerNSignal = await gns.getCuratorSignal(subgraphID, owner.address)
    const beforeRecipientNSignal = await gns.getCuratorSignal(subgraphID, recipient.address)

    // Transfer
    const tx = gns.connect(owner.signer).transferSignal(subgraphID, recipient.address, amount)

    await expect(tx)
      .emit(gns, 'SignalTransferred')
      .withArgs(subgraphID, owner.address, recipient.address, amount)

    // After state
    const afterOwnerNSignal = await gns.getCuratorSignal(subgraphID, owner.address)
    const afterRecipientNSignal = await gns.getCuratorSignal(subgraphID, recipient.address)

    // Check state
    expect(afterOwnerNSignal).eq(beforeOwnerNSignal.sub(amount))
    expect(afterRecipientNSignal).eq(beforeRecipientNSignal.add(amount))

    return tx
  }

  const withdraw = async (account: Account, subgraphID: string): Promise<ContractTransaction> => {
    // Before state
    const beforeCuratorNSignal = await gns.getCuratorSignal(subgraphID, account.address)
    const beforeSubgraph = await gns.subgraphs(subgraphID)
    const beforeGNSBalance = await grt.balanceOf(gns.address)
    const tokensEstimate = beforeSubgraph.withdrawableGRT
      .mul(beforeCuratorNSignal)
      .div(beforeSubgraph.nSignal)

    // Send tx
    const tx = gns.connect(account.signer).withdraw(subgraphID)
    await expect(tx)
      .emit(gns, 'GRTWithdrawn')
      .withArgs(subgraphID, account.address, beforeCuratorNSignal, tokensEstimate)

    // curator nSignal should be updated
    const afterCuratorNSignal = await gns.getCuratorSignal(subgraphID, account.address)
    expect(afterCuratorNSignal).eq(toBN(0))

    // overall n signal should be updated
    const afterSubgraph = await gns.subgraphs(subgraphID)
    expect(afterSubgraph.nSignal).eq(beforeSubgraph.nSignal.sub(beforeCuratorNSignal))

    // Token balance should be updated
    const afterGNSBalance = await grt.balanceOf(gns.address)
    expect(afterGNSBalance).eq(beforeGNSBalance.sub(tokensEstimate))

    return tx
  }

  const deployLegacyGNSMock = async (): Promise<any> => {
    const bondingCurve = (await deployContract(
      'BancorFormula',
      governor.signer,
    )) as unknown as BancorFormula
    const subgraphDescriptor = await deployContract('SubgraphNFTDescriptor', governor.signer)
    const subgraphNFT = (await deployContract(
      'SubgraphNFT',
      governor.signer,
      governor.address,
    )) as SubgraphNFT

    // Deploy
    legacyGNSMock = (await network.deployContractWithProxy(
      proxyAdmin,
      'LegacyGNSMock',
      [controller.address, bondingCurve.address, subgraphNFT.address],
      governor.signer,
    )) as unknown as LegacyGNSMock

    // Post-config
    await subgraphNFT.connect(governor.signer).setMinter(legacyGNSMock.address)
    await subgraphNFT.connect(governor.signer).setTokenDescriptor(subgraphDescriptor.address)
    await legacyGNSMock.connect(governor.signer).syncAllContracts()
    await legacyGNSMock.connect(governor.signer).approveAll()
    await l1GraphTokenGateway.connect(governor.signer).addToCallhookWhitelist(legacyGNSMock.address)
    await legacyGNSMock.connect(governor.signer).setCounterpartGNSAddress(mockL2GNS.address)
  }

  before(async function () {
    ;[me, other, governor, another, mockRouter, mockL2GRT, mockL2Gateway, mockL2GNS] =
      await getAccounts()
    fixture = new NetworkFixture()
    const fixtureContracts = await fixture.load(governor.signer)
    ;({ grt, curation, gns, controller, proxyAdmin, l1GraphTokenGateway } = fixtureContracts)
    newSubgraph0 = buildSubgraph()
    newSubgraph1 = buildSubgraph()
    defaultName = createDefaultName('graph')
    // Give some funds to the signers and approve gns contract to use funds on signers behalf
    await grt.connect(governor.signer).mint(me.address, tokens100000)
    await grt.connect(governor.signer).mint(other.address, tokens100000)
    await grt.connect(me.signer).approve(gns.address, tokens100000)
    await grt.connect(me.signer).approve(curation.address, tokens100000)
    await grt.connect(other.signer).approve(gns.address, tokens100000)
    await grt.connect(other.signer).approve(curation.address, tokens100000)
    // Update curation tax to test the functionality of it in disableNameSignal()
    await curation.connect(governor.signer).setCurationTaxPercentage(curationTaxPercentage)

    // Deploying a GNS mock with support for legacy subgraphs
    await deployLegacyGNSMock()
    await grt.connect(me.signer).approve(legacyGNSMock.address, tokens100000)

    const arbitrumMocks = await fixture.loadArbitrumL1Mocks(governor.signer)
    await fixture.configureL1Bridge(
      governor.signer,
      arbitrumMocks,
      fixtureContracts,
      mockRouter.address,
      mockL2GRT.address,
      mockL2Gateway.address,
      mockL2GNS.address,
    )
  })

  beforeEach(async function () {
    await fixture.setUp()
  })

  afterEach(async function () {
    await fixture.tearDown()
  })

  describe('Configuration', async function () {
    describe('setOwnerTaxPercentage', function () {
      const newValue = 10

      it('should set `ownerTaxPercentage`', async function () {
        // Can set if allowed
        await gns.connect(governor.signer).setOwnerTaxPercentage(newValue)
        expect(await gns.ownerTaxPercentage()).eq(newValue)
      })

      it('reject set `ownerTaxPercentage` if out of bounds', async function () {
        const tx = gns.connect(governor.signer).setOwnerTaxPercentage(1000001)
        await expect(tx).revertedWith('Owner tax must be MAX_PPM or less')
      })

      it('reject set `ownerTaxPercentage` if not allowed', async function () {
        const tx = gns.connect(me.signer).setOwnerTaxPercentage(newValue)
        await expect(tx).revertedWith('Only Controller governor')
      })
    })

    describe('setCounterpartGNSAddress', function () {
      it('should set `counterpartGNSAddress`', async function () {
        // Can set if allowed
        const newValue = other.address
        const tx = gns.connect(governor.signer).setCounterpartGNSAddress(newValue)
        await expect(tx).emit(gns, 'CounterpartGNSAddressUpdated').withArgs(newValue)
        expect(await gns.counterpartGNSAddress()).eq(newValue)
      })

      it('reject set `counterpartGNSAddress` if not allowed', async function () {
        const newValue = other.address
        const tx = gns.connect(me.signer).setCounterpartGNSAddress(newValue)
        await expect(tx).revertedWith('Caller must be Controller governor')
      })
    })

    describe('setArbitrumInboxAddress', function () {
      it('should set `arbitrumInboxAddress`', async function () {
        // Can set if allowed
        const newValue = other.address
        const tx = gns.connect(governor.signer).setArbitrumInboxAddress(newValue)
        await expect(tx).emit(gns, 'ArbitrumInboxAddressUpdated').withArgs(newValue)
        expect(await gns.arbitrumInboxAddress()).eq(newValue)
      })

      it('reject set `arbitrumInboxAddress` if not allowed', async function () {
        const newValue = other.address
        const tx = gns.connect(me.signer).setArbitrumInboxAddress(newValue)
        await expect(tx).revertedWith('Caller must be Controller governor')
      })
    })

    describe('setSubgraphNFT', function () {
      it('should set `setSubgraphNFT`', async function () {
        const newValue = gns.address // I just use any contract address
        const tx = gns.connect(governor.signer).setSubgraphNFT(newValue)
        await expect(tx).emit(gns, 'SubgraphNFTUpdated').withArgs(newValue)
        expect(await gns.subgraphNFT()).eq(newValue)
      })

      it('revert set to empty address', async function () {
        const tx = gns.connect(governor.signer).setSubgraphNFT(AddressZero)
        await expect(tx).revertedWith('NFT address cant be zero')
      })

      it('revert set to non-contract', async function () {
        const tx = gns.connect(governor.signer).setSubgraphNFT(randomHexBytes(20))
        await expect(tx).revertedWith('NFT must be valid')
      })
    })
  })

  describe('Publishing names and versions', function () {
    describe('setDefaultName', function () {
      it('setDefaultName emits the event', async function () {
        const tx = gns
          .connect(me.signer)
          .setDefaultName(me.address, 0, defaultName.nameIdentifier, defaultName.name)
        await expect(tx)
          .emit(gns, 'SetDefaultName')
          .withArgs(me.address, 0, defaultName.nameIdentifier, defaultName.name)
      })

      it('setDefaultName fails if not owner', async function () {
        const tx = gns
          .connect(other.signer)
          .setDefaultName(me.address, 0, defaultName.nameIdentifier, defaultName.name)
        await expect(tx).revertedWith('GNS: Only you can set your name')
      })
    })

    describe('updateSubgraphMetadata', function () {
      let subgraph: Subgraph

      beforeEach(async function () {
        subgraph = await publishNewSubgraph(me, newSubgraph0)
      })

      it('updateSubgraphMetadata emits the event', async function () {
        const tx = gns
          .connect(me.signer)
          .updateSubgraphMetadata(subgraph.id, newSubgraph0.subgraphMetadata)
        await expect(tx)
          .emit(gns, 'SubgraphMetadataUpdated')
          .withArgs(subgraph.id, newSubgraph0.subgraphMetadata)
      })

      it('updateSubgraphMetadata fails if not owner', async function () {
        const tx = gns
          .connect(other.signer)
          .updateSubgraphMetadata(subgraph.id, newSubgraph0.subgraphMetadata)
        await expect(tx).revertedWith('GNS: Must be authorized')
      })
    })

    describe('isPublished', function () {
      it('should return if the subgraph is published', async function () {
        const subgraphID = await buildSubgraphID(me.address, toBN(0))
        expect(await gns.isPublished(subgraphID)).eq(false)
        await publishNewSubgraph(me, newSubgraph0)
        expect(await gns.isPublished(subgraphID)).eq(true)
      })
    })

    describe('publishNewSubgraph', async function () {
      it('should publish a new subgraph and first version with it', async function () {
        await publishNewSubgraph(me, newSubgraph0)
      })

      it('should publish a new subgraph with an incremented value', async function () {
        const subgraph1 = await publishNewSubgraph(me, newSubgraph0)
        const subgraph2 = await publishNewSubgraph(me, newSubgraph1)
        expect(subgraph1.id).not.eq(subgraph2.id)
      })

      it('should prevent subgraphDeploymentID of 0 to be used', async function () {
        const tx = gns
          .connect(me.signer)
          .publishNewSubgraph(HashZero, newSubgraph0.versionMetadata, newSubgraph0.subgraphMetadata)
        await expect(tx).revertedWith('GNS: Cannot set deploymentID to 0 in publish')
      })
    })

    describe('publishNewVersion', async function () {
      let subgraph: Subgraph

      beforeEach(async () => {
        subgraph = await publishNewSubgraph(me, newSubgraph0)
        await mintSignal(me, subgraph.id, tokens10000)
      })

      it('should publish a new version on an existing subgraph', async function () {
        await publishNewVersion(me, subgraph.id, newSubgraph1)
      })

      it('should publish a new version on an existing subgraph with no current signal', async function () {
        const emptySignalSubgraph = await publishNewSubgraph(me, buildSubgraph())
        await publishNewVersion(me, emptySignalSubgraph.id, newSubgraph1)
      })

      it('should reject a new version with the same subgraph deployment ID', async function () {
        const tx = gns
          .connect(me.signer)
          .publishNewVersion(
            subgraph.id,
            newSubgraph0.subgraphDeploymentID,
            newSubgraph0.versionMetadata,
          )
        await expect(tx).revertedWith(
          'GNS: Cannot publish a new version with the same subgraph deployment ID',
        )
      })

      it('should reject publishing a version to a subgraph that does not exist', async function () {
        const tx = gns
          .connect(me.signer)
          .publishNewVersion(
            randomHexBytes(32),
            newSubgraph1.subgraphDeploymentID,
            newSubgraph1.versionMetadata,
          )
        await expect(tx).revertedWith('ERC721: owner query for nonexistent token')
      })

      it('reject if not the owner', async function () {
        const tx = gns
          .connect(other.signer)
          .publishNewVersion(
            subgraph.id,
            newSubgraph1.subgraphDeploymentID,
            newSubgraph1.versionMetadata,
          )
        await expect(tx).revertedWith('GNS: Must be authorized')
      })

      it('should fail when upgrade tries to point to a pre-curated', async function () {
        // Curate directly to the deployment
        await curation.connect(me.signer).mint(newSubgraph1.subgraphDeploymentID, tokens1000, 0)

        // Target a pre-curated subgraph deployment
        const tx = gns
          .connect(me.signer)
          .publishNewVersion(
            subgraph.id,
            newSubgraph1.subgraphDeploymentID,
            newSubgraph1.versionMetadata,
          )
        await expect(tx).revertedWith(
          'GNS: Owner cannot point to a subgraphID that has been pre-curated',
        )
      })

      it('should upgrade version when there is no signal with no signal migration', async function () {
        await burnSignal(me, subgraph.id)
        const tx = gns
          .connect(me.signer)
          .publishNewVersion(
            subgraph.id,
            newSubgraph1.subgraphDeploymentID,
            newSubgraph1.versionMetadata,
          )
        await expect(tx)
          .emit(gns, 'SubgraphVersionUpdated')
          .withArgs(subgraph.id, newSubgraph1.subgraphDeploymentID, newSubgraph1.versionMetadata)
      })

      it('should fail when subgraph is deprecated', async function () {
        await deprecateSubgraph(me, subgraph.id)
        const tx = gns
          .connect(me.signer)
          .publishNewVersion(
            subgraph.id,
            newSubgraph1.subgraphDeploymentID,
            newSubgraph1.versionMetadata,
          )
        // NOTE: deprecate burns the Subgraph NFT, when someone wants to publish a new version it won't find it
        await expect(tx).revertedWith('ERC721: owner query for nonexistent token')
      })
    })

    describe('deprecateSubgraph', async function () {
      let subgraph: Subgraph

      beforeEach(async () => {
        subgraph = await publishNewSubgraph(me, newSubgraph0)
        await mintSignal(me, subgraph.id, tokens10000)
      })

      it('should deprecate a subgraph', async function () {
        await deprecateSubgraph(me, subgraph.id)
      })

      it('should prevent a deprecated subgraph from being republished', async function () {
        await deprecateSubgraph(me, subgraph.id)
        const tx = gns
          .connect(me.signer)
          .publishNewVersion(
            subgraph.id,
            newSubgraph1.subgraphDeploymentID,
            newSubgraph1.versionMetadata,
          )
        // NOTE: deprecate burns the Subgraph NFT, when someone wants to publish a new version it won't find it
        await expect(tx).revertedWith('ERC721: owner query for nonexistent token')
      })

      it('reject if the subgraph does not exist', async function () {
        const subgraphID = randomHexBytes(32)
        const tx = gns.connect(me.signer).deprecateSubgraph(subgraphID)
        await expect(tx).revertedWith('ERC721: owner query for nonexistent token')
      })

      it('reject deprecate if not the owner', async function () {
        const tx = gns.connect(other.signer).deprecateSubgraph(subgraph.id)
        await expect(tx).revertedWith('GNS: Must be authorized')
      })
    })
  })

  describe('Curating on names', async function () {
    describe('mintSignal()', async function () {
      it('should deposit into the name signal curve', async function () {
        const subgraph = await publishNewSubgraph(me, newSubgraph0)
        await mintSignal(other, subgraph.id, tokens10000)
      })

      it('should fail when name signal is disabled', async function () {
        const subgraph = await publishNewSubgraph(me, newSubgraph0)
        await deprecateSubgraph(me, subgraph.id)
        const tx = gns.connect(me.signer).mintSignal(subgraph.id, tokens1000, 0)
        await expect(tx).revertedWith('GNS: Must be active')
      })

      it('should fail if you try to deposit on a non existing name', async function () {
        const subgraphID = randomHexBytes(32)
        const tx = gns.connect(me.signer).mintSignal(subgraphID, tokens1000, 0)
        await expect(tx).revertedWith('GNS: Must be active')
      })

      it('reject minting if under slippage', async function () {
        // First publish the subgraph
        const subgraph = await publishNewSubgraph(me, newSubgraph0)

        // Set slippage to be 1 less than expected result to force reverting
        const { 1: expectedNSignal } = await gns.tokensToNSignal(subgraph.id, tokens1000)
        const tx = gns
          .connect(me.signer)
          .mintSignal(subgraph.id, tokens1000, expectedNSignal.add(1))
        await expect(tx).revertedWith('Slippage protection')
      })
    })

    describe('burnSignal()', async function () {
      let subgraph: Subgraph

      beforeEach(async () => {
        subgraph = await publishNewSubgraph(me, newSubgraph0)
        await mintSignal(other, subgraph.id, tokens10000)
      })

      it('should withdraw from the name signal curve', async function () {
        await burnSignal(other, subgraph.id)
      })

      it('should fail when name signal is disabled', async function () {
        await deprecateSubgraph(me, subgraph.id)
        // just test 1 since it will fail
        const tx = gns.connect(me.signer).burnSignal(subgraph.id, 1, 0)
        await expect(tx).revertedWith('GNS: Must be active')
      })

      it('should fail when the curator tries to withdraw more nSignal than they have', async function () {
        const tx = gns.connect(me.signer).burnSignal(
          subgraph.id,
          // 1000000 * 10^18 nSignal is a lot, and will cause fail
          toBN('1000000000000000000000000'),
          0,
        )
        await expect(tx).revertedWith('GNS: Curator cannot withdraw more nSignal than they have')
      })

      it('reject burning if under slippage', async function () {
        // Get current curator name signal
        const curatorNSignal = await gns.getCuratorSignal(subgraph.id, other.address)

        // Withdraw
        const { 1: expectedTokens } = await gns.nSignalToTokens(subgraph.id, curatorNSignal)

        // Force a revert by asking 1 more token than the function will return
        const tx = gns
          .connect(other.signer)
          .burnSignal(subgraph.id, curatorNSignal, expectedTokens.add(1))
        await expect(tx).revertedWith('Slippage protection')
      })
    })

    describe('transferSignal()', async function () {
      let subgraph: Subgraph
      let otherNSignal: BigNumber

      beforeEach(async () => {
        subgraph = await publishNewSubgraph(me, newSubgraph0)
        await mintSignal(other, subgraph.id, tokens10000)
        otherNSignal = await gns.getCuratorSignal(subgraph.id, other.address)
      })

      it('should transfer signal from one curator to another', async function () {
        await transferSignal(subgraph.id, other, another, otherNSignal)
      })
      it('should fail when transfering to zero address', async function () {
        const tx = gns
          .connect(other.signer)
          .transferSignal(subgraph.id, ethers.constants.AddressZero, otherNSignal)
        await expect(tx).revertedWith('GNS: Curator cannot transfer to the zero address')
      })
      it('should fail when name signal is disabled', async function () {
        await deprecateSubgraph(me, subgraph.id)
        const tx = gns
          .connect(other.signer)
          .transferSignal(subgraph.id, another.address, otherNSignal)
        await expect(tx).revertedWith('GNS: Must be active')
      })
      it('should fail if you try to transfer on a non existing name', async function () {
        const subgraphID = randomHexBytes(32)
        const tx = gns
          .connect(other.signer)
          .transferSignal(subgraphID, another.address, otherNSignal)
        await expect(tx).revertedWith('GNS: Must be active')
      })
      it('should fail when the curator tries to transfer more signal than they have', async function () {
        const tx = gns
          .connect(other.signer)
          .transferSignal(subgraph.id, another.address, otherNSignal.add(otherNSignal))
        await expect(tx).revertedWith('GNS: Curator transfer amount exceeds balance')
      })
    })
    describe('withdraw()', async function () {
      let subgraph: Subgraph

      beforeEach(async () => {
        subgraph = await publishNewSubgraph(me, newSubgraph0)
        await mintSignal(other, subgraph.id, tokens10000)
      })

      it('should withdraw GRT from a disabled name signal', async function () {
        await deprecateSubgraph(me, subgraph.id)
        await withdraw(other, subgraph.id)
      })

      it('should fail if not disabled', async function () {
        const tx = gns.connect(other.signer).withdraw(subgraph.id)
        await expect(tx).revertedWith('GNS: Must be disabled first')
      })

      it('should fail when there is no more GRT to withdraw', async function () {
        await deprecateSubgraph(me, subgraph.id)
        await withdraw(other, subgraph.id)
        const tx = gns.connect(other.signer).withdraw(subgraph.id)
        await expect(tx).revertedWith('GNS: No more GRT to withdraw')
      })

      it('should fail if the curator has no nSignal', async function () {
        await deprecateSubgraph(me, subgraph.id)
        const tx = gns.connect(me.signer).withdraw(subgraph.id)
        await expect(tx).revertedWith('GNS: No signal to withdraw GRT')
      })
    })

    describe('multiple minting', async function () {
      it('should mint less signal every time due to the bonding curve', async function () {
        const tokensToDepositMany = [
          toGRT('1000'), // should mint if we start with number above minimum deposit
          toGRT('1000'), // every time it should mint less GCS due to bonding curve...
          toGRT('1.06'), // should mint minimum deposit including tax
          toGRT('1000'),
          toGRT('1000'),
          toGRT('2000'),
          toGRT('2000'),
          toGRT('123'),
        ]
        const subgraph = await publishNewSubgraph(me, newSubgraph0)

        // State updated
        const curationTaxPercentage = await curation.curationTaxPercentage()

        for (const tokensToDeposit of tokensToDepositMany) {
          const beforeSubgraph = await gns.subgraphs(subgraph.id)
          expect(newSubgraph0.subgraphDeploymentID).eq(beforeSubgraph.subgraphDeploymentID)

          const curationTax = toBN(curationTaxPercentage).mul(tokensToDeposit).div(toBN(1000000))
          const expectedNSignal = await calcGNSBondingCurve(
            beforeSubgraph.nSignal,
            beforeSubgraph.vSignal,
            beforeSubgraph.reserveRatio,
            tokensToDeposit.sub(curationTax),
            beforeSubgraph.subgraphDeploymentID,
          )
          const tx = await mintSignal(me, subgraph.id, tokensToDeposit)
          const receipt = await tx.wait()
          const event: Event = receipt.events.pop()
          const nSignalCreated = event.args['nSignalCreated']
          expect(toRound(expectedNSignal)).eq(toRound(toFloat(nSignalCreated)))
        }
      })

      it('should mint when using the edge case of linear function', async function () {
        // Setup edge case like linear function: 1 vSignal = 1 nSignal = 1 token
        await curation.setMinimumCurationDeposit(toGRT('1'))
        await curation.setDefaultReserveRatio(1000000)
        // note - reserve ratio is already set to 1000000 in GNS

        const tokensToDepositMany = [
          toGRT('1000'), // should mint if we start with number above minimum deposit
          toGRT('1000'), // every time it should mint less GCS due to bonding curve...
          toGRT('1000'),
          toGRT('1000'),
          toGRT('2000'),
          toGRT('2000'),
          toGRT('123'),
          toGRT('1'), // should mint below minimum deposit
        ]

        const subgraph = await publishNewSubgraph(me, newSubgraph0)

        // State updated
        for (const tokensToDeposit of tokensToDepositMany) {
          await mintSignal(me, subgraph.id, tokensToDeposit)
        }
      })
    })
  })

  describe('Two named subgraphs point to the same subgraph deployment ID', function () {
    it('handle initialization under minimum signal values', async function () {
      await curation.setMinimumCurationDeposit(toGRT('1'))

      // Publish a named subgraph-0 -> subgraphDeployment0
      const subgraph0 = await publishNewSubgraph(me, newSubgraph0)
      // Curate on the first subgraph
      await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

      // Publish a named subgraph-1 -> subgraphDeployment0
      const subgraph1 = await publishNewSubgraph(me, newSubgraph0)
      // Curate on the second subgraph should work
      await gns.connect(me.signer).mintSignal(subgraph1.id, toGRT('10'), 0)
    })
  })

  describe('batch calls', function () {
    it('should publish new subgraph and mint signal in single transaction', async function () {
      // Create a subgraph
      const tx1 = await gns.populateTransaction.publishNewSubgraph(
        newSubgraph0.subgraphDeploymentID,
        newSubgraph0.versionMetadata,
        newSubgraph0.subgraphMetadata,
      )
      // Curate on the subgraph
      const subgraphID = await buildSubgraphID(me.address, await gns.nextAccountSeqID(me.address))
      const tx2 = await gns.populateTransaction.mintSignal(subgraphID, toGRT('90000'), 0)

      // Batch send transaction
      await gns.connect(me.signer).multicall([tx1.data, tx2.data])
    })

    it('should revert if batching a call to non-authorized function', async function () {
      // Call a forbidden function
      const tx1 = await gns.populateTransaction.setOwnerTaxPercentage(100)

      // Create a subgraph
      const tx2 = await gns.populateTransaction.publishNewSubgraph(
        newSubgraph0.subgraphDeploymentID,
        newSubgraph0.versionMetadata,
        newSubgraph0.subgraphMetadata,
      )

      // Batch send transaction
      const tx = gns.connect(me.signer).multicall([tx1.data, tx2.data])
      await expect(tx).revertedWith('Only Controller governor')
    })

    it('should revert if batching a call to initialize', async function () {
      // Call a forbidden function
      const tx1 = await gns.populateTransaction.initialize(me.address, me.address, me.address)

      // Create a subgraph
      const tx2 = await gns.populateTransaction.publishNewSubgraph(
        newSubgraph0.subgraphDeploymentID,
        newSubgraph0.versionMetadata,
        newSubgraph0.subgraphMetadata,
      )

      // Batch send transaction
      const tx = gns.connect(me.signer).multicall([tx1.data, tx2.data])
      await expect(tx).revertedWith('Only implementation')
    })

    it('should revert if trying to call a private function', async function () {
      // Craft call a private function
      const hash = ethers.utils.id('_setOwnerTaxPercentage(uint32)')
      const functionHash = hash.slice(0, 10)
      const calldata = ethers.utils.arrayify(
        ethers.utils.defaultAbiCoder.encode(['uint32'], ['100']),
      )
      const bogusPayload = ethers.utils.concat([functionHash, calldata])

      // Create a subgraph
      const tx2 = await gns.populateTransaction.publishNewSubgraph(
        newSubgraph0.subgraphDeploymentID,
        newSubgraph0.versionMetadata,
        newSubgraph0.subgraphMetadata,
      )

      // Batch send transaction
      const tx = gns.connect(me.signer).multicall([bogusPayload, tx2.data])
      await expect(tx).revertedWith('')
    })
  })

  describe('NFT descriptor', function () {
    it('with token descriptor', async function () {
      const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

      const subgraphNFTAddress = await gns.subgraphNFT()
      const subgraphNFT = getContractAt('SubgraphNFT', subgraphNFTAddress) as SubgraphNFT
      const tokenURI = await subgraphNFT.connect(me.signer).tokenURI(subgraph0.id)

      const sub = new SubgraphDeploymentID(newSubgraph0.subgraphMetadata)
      expect(sub.ipfsHash).eq(tokenURI)
    })

    it('with token descriptor and baseURI', async function () {
      const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

      const subgraphNFTAddress = await gns.subgraphNFT()
      const subgraphNFT = getContractAt('SubgraphNFT', subgraphNFTAddress) as SubgraphNFT
      await subgraphNFT.connect(governor.signer).setBaseURI('ipfs://')
      const tokenURI = await subgraphNFT.connect(me.signer).tokenURI(subgraph0.id)

      const sub = new SubgraphDeploymentID(newSubgraph0.subgraphMetadata)
      expect('ipfs://' + sub.ipfsHash).eq(tokenURI)
    })

    it('without token descriptor', async function () {
      const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

      const subgraphNFTAddress = await gns.subgraphNFT()
      const subgraphNFT = getContractAt('SubgraphNFT', subgraphNFTAddress) as SubgraphNFT
      await subgraphNFT.connect(governor.signer).setTokenDescriptor(AddressZero)
      const tokenURI = await subgraphNFT.connect(me.signer).tokenURI(subgraph0.id)

      const sub = new SubgraphDeploymentID(newSubgraph0.subgraphMetadata)
      expect(sub.bytes32).eq(tokenURI)
    })

    it('without token descriptor and baseURI', async function () {
      const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

      const subgraphNFTAddress = await gns.subgraphNFT()
      const subgraphNFT = getContractAt('SubgraphNFT', subgraphNFTAddress) as SubgraphNFT
      await subgraphNFT.connect(governor.signer).setTokenDescriptor(AddressZero)
      await subgraphNFT.connect(governor.signer).setBaseURI('ipfs://')
      const tokenURI = await subgraphNFT.connect(me.signer).tokenURI(subgraph0.id)

      const sub = new SubgraphDeploymentID(newSubgraph0.subgraphMetadata)
      expect('ipfs://' + sub.bytes32).eq(tokenURI)
    })

    it('without token descriptor and 0x0 metadata', async function () {
      const newSubgraphNoMetadata = buildSubgraph()
      newSubgraphNoMetadata.subgraphMetadata = HashZero
      const subgraph0 = await publishNewSubgraph(me, newSubgraphNoMetadata)

      const subgraphNFTAddress = await gns.subgraphNFT()
      const subgraphNFT = getContractAt('SubgraphNFT', subgraphNFTAddress) as SubgraphNFT
      await subgraphNFT.connect(governor.signer).setTokenDescriptor(AddressZero)
      await subgraphNFT.connect(governor.signer).setBaseURI('ipfs://')
      const tokenURI = await subgraphNFT.connect(me.signer).tokenURI(subgraph0.id)
      expect('ipfs://' + subgraph0.id).eq(tokenURI)
    })
  })
  describe('Legacy subgraph migration', function () {
    it('migrates a legacy subgraph', async function () {
      const seqID = toBN('2')
      await legacyGNSMock
        .connect(me.signer)
        .createLegacySubgraph(seqID, newSubgraph0.subgraphDeploymentID)
      const tx = legacyGNSMock
        .connect(me.signer)
        .migrateLegacySubgraph(me.address, seqID, newSubgraph0.subgraphMetadata)
      await expect(tx).emit(legacyGNSMock, ' LegacySubgraphClaimed').withArgs(me.address, seqID)
      const expectedSubgraphID = buildLegacySubgraphID(me.address, seqID)
      const migratedSubgraphDeploymentID = await legacyGNSMock.getSubgraphDeploymentID(
        expectedSubgraphID,
      )
      const migratedNSignal = await legacyGNSMock.getSubgraphNSignal(expectedSubgraphID)
      expect(migratedSubgraphDeploymentID).eq(newSubgraph0.subgraphDeploymentID)
      expect(migratedNSignal).eq(toBN('1000'))

      const subgraphNFTAddress = await legacyGNSMock.subgraphNFT()
      const subgraphNFT = getContractAt('SubgraphNFT', subgraphNFTAddress) as SubgraphNFT
      const tokenURI = await subgraphNFT.connect(me.signer).tokenURI(expectedSubgraphID)

      const sub = new SubgraphDeploymentID(newSubgraph0.subgraphMetadata)
      expect(sub.ipfsHash).eq(tokenURI)
    })
    it('refuses to migrate an already migrated subgraph', async function () {
      const seqID = toBN('2')
      await legacyGNSMock
        .connect(me.signer)
        .createLegacySubgraph(seqID, newSubgraph0.subgraphDeploymentID)
      let tx = legacyGNSMock
        .connect(me.signer)
        .migrateLegacySubgraph(me.address, seqID, newSubgraph0.subgraphMetadata)
      await expect(tx).emit(legacyGNSMock, ' LegacySubgraphClaimed').withArgs(me.address, seqID)
      tx = legacyGNSMock
        .connect(me.signer)
        .migrateLegacySubgraph(me.address, seqID, newSubgraph0.subgraphMetadata)
      await expect(tx).revertedWith('GNS: Subgraph was already claimed')
    })
  })
  describe('Subgraph migration to L2', function () {
    describe('lockSubgraphForMigrationToL2', function () {
      it('locks and disables a subgraph, burning the signal and storing the block number', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)
        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const curatedTokens = await grt.balanceOf(curation.address)
        const subgraphBefore = await gns.subgraphs(subgraph0.id)
        expect(subgraphBefore.vSignal).not.eq(0)
        const tx = gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)
        await expect(tx).emit(gns, 'SubgraphLockedForMigrationToL2').withArgs(subgraph0.id)

        const subgraphAfter = await gns.subgraphs(subgraph0.id)
        expect(subgraphAfter.vSignal).eq(0)
        expect(subgraphAfter.nSignal).eq(subgraphBefore.nSignal)
        expect(await grt.balanceOf(gns.address)).eq(curatedTokens)
        expect(subgraphAfter.disabled).eq(true)
        expect(subgraphAfter.withdrawableGRT).eq(0)

        const migrationData = await gns.subgraphL2MigrationData(subgraph0.id)
        expect(migrationData.lockedAtBlock).eq(await latestBlock())
        expect(migrationData.l1Done).eq(false)

        let invalidTx = gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)
        await expect(invalidTx).revertedWith('GNS: Must be active')
        invalidTx = gns.connect(me.signer).burnSignal(subgraph0.id, toGRT('90000'), 0)
        await expect(invalidTx).revertedWith('GNS: Must be active')
      })
      it('locks and disables a legacy subgraph, burning the signal and storing the block number', async function () {
        const seqID = toBN('2')
        await legacyGNSMock
          .connect(me.signer)
          .createLegacySubgraph(seqID, newSubgraph0.subgraphDeploymentID)
        // The legacy subgraph must be claimed
        const migrateTx = legacyGNSMock
          .connect(me.signer)
          .migrateLegacySubgraph(me.address, seqID, newSubgraph0.subgraphMetadata)
        await expect(migrateTx)
          .emit(legacyGNSMock, ' LegacySubgraphClaimed')
          .withArgs(me.address, seqID)
        const subgraphID = buildLegacySubgraphID(me.address, seqID)

        // Curate on the subgraph
        await legacyGNSMock.connect(me.signer).mintSignal(subgraphID, toGRT('10000'), 0)

        const curatedTokens = await grt.balanceOf(curation.address)
        const subgraphBefore = await legacyGNSMock.legacySubgraphData(me.address, seqID)
        expect(subgraphBefore.vSignal).not.eq(0)
        const tx = legacyGNSMock.connect(me.signer).lockSubgraphForMigrationToL2(subgraphID)
        await expect(tx).emit(legacyGNSMock, 'SubgraphLockedForMigrationToL2').withArgs(subgraphID)

        const subgraphAfter = await legacyGNSMock.legacySubgraphData(me.address, seqID)
        expect(subgraphAfter.vSignal).eq(0)
        expect(subgraphAfter.nSignal).eq(subgraphBefore.nSignal)
        expect(await grt.balanceOf(legacyGNSMock.address)).eq(curatedTokens)
        expect(subgraphAfter.disabled).eq(true)
        expect(subgraphAfter.withdrawableGRT).eq(0)

        const migrationData = await legacyGNSMock.subgraphL2MigrationData(subgraphID)
        expect(migrationData.lockedAtBlock).eq(await latestBlock())
        expect(migrationData.l1Done).eq(false)

        let invalidTx = legacyGNSMock.connect(me.signer).mintSignal(subgraphID, toGRT('90000'), 0)
        await expect(invalidTx).revertedWith('GNS: Must be active')
        invalidTx = legacyGNSMock.connect(me.signer).burnSignal(subgraphID, toGRT('90000'), 0)
        await expect(invalidTx).revertedWith('GNS: Must be active')
      })
      it('rejects calls from someone who is not the subgraph owner', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)
        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const tx = gns.connect(other.signer).lockSubgraphForMigrationToL2(subgraph0.id)
        await expect(tx).revertedWith('GNS: Must be authorized')
      })
      it('rejects a call for a non-existent subgraph', async function () {
        const subgraphID = buildLegacySubgraphID(me.address, toBN('0'))

        const tx = gns.connect(other.signer).lockSubgraphForMigrationToL2(subgraphID)
        await expect(tx).revertedWith('ERC721: owner query for nonexistent token')
      })
      it('rejects a call for a subgraph that is already locked', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)
        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const tx = gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)
        await expect(tx).emit(gns, 'SubgraphLockedForMigrationToL2').withArgs(subgraph0.id)

        const tx2 = gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)
        await expect(tx2).revertedWith('GNS: Must be active')
      })
      it('rejects a call for a subgraph that is deprecated', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)
        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        await gns.connect(me.signer).deprecateSubgraph(subgraph0.id)

        const tx2 = gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)
        // Deprecating the subgraph burns the NFT
        await expect(tx2).revertedWith('ERC721: owner query for nonexistent token')
      })
    })
    describe('sendSubgraphToL2', function () {
      it('sends tokens and calldata to L2 through the GRT bridge', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const curatedTokens = await grt.balanceOf(curation.address)
        const subgraphBefore = await gns.subgraphs(subgraph0.id)
        const lockTx = await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)
        const lockReceipt = await lockTx.wait()
        const lockBlockhash = lockReceipt.blockHash

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = gns
          .connect(me.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).emit(gns, 'SubgraphSentToL2').withArgs(subgraph0.id)

        const subgraphAfter = await gns.subgraphs(subgraph0.id)
        expect(subgraphAfter.vSignal).eq(0)
        expect(await grt.balanceOf(gns.address)).eq(0)
        expect(subgraphAfter.disabled).eq(true)
        expect(subgraphAfter.withdrawableGRT).eq(0)

        const migrationData = await gns.subgraphL2MigrationData(subgraph0.id)
        expect(migrationData.lockedAtBlock).eq((await latestBlock()).sub(1))
        expect(migrationData.l1Done).eq(true)

        const expectedCallhookData = l2GNSIface.encodeFunctionData('receiveSubgraphFromL1', [
          subgraph0.id,
          me.address,
          curatedTokens,
          lockBlockhash,
          subgraphBefore.nSignal,
          subgraphBefore.reserveRatio,
          newSubgraph0.subgraphMetadata,
        ])

        const expectedL2Data = await l1GraphTokenGateway.getOutboundCalldata(
          grt.address,
          gns.address,
          mockL2GNS.address,
          curatedTokens,
          expectedCallhookData,
        )
        await expect(tx)
          .emit(l1GraphTokenGateway, 'TxToL2')
          .withArgs(gns.address, mockL2Gateway.address, toBN(1), expectedL2Data)
      })
      it('sends tokens and calldata for a legacy subgraph to L2 through the GRT bridge', async function () {
        const seqID = toBN('2')
        await legacyGNSMock
          .connect(me.signer)
          .createLegacySubgraph(seqID, newSubgraph0.subgraphDeploymentID)
        const migrateTx = legacyGNSMock
          .connect(me.signer)
          .migrateLegacySubgraph(me.address, seqID, newSubgraph0.subgraphMetadata)
        await expect(migrateTx)
          .emit(legacyGNSMock, ' LegacySubgraphClaimed')
          .withArgs(me.address, seqID)
        const subgraphID = buildLegacySubgraphID(me.address, seqID)

        // Curate on the subgraph
        await legacyGNSMock.connect(me.signer).mintSignal(subgraphID, toGRT('90000'), 0)

        const curatedTokens = await grt.balanceOf(curation.address)
        const subgraphBefore = await legacyGNSMock.legacySubgraphData(me.address, seqID)
        const lockTx = await legacyGNSMock
          .connect(me.signer)
          .lockSubgraphForMigrationToL2(subgraphID)
        const lockReceipt = await lockTx.wait()
        const lockBlockhash = lockReceipt.blockHash

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = legacyGNSMock
          .connect(me.signer)
          .sendSubgraphToL2(subgraphID, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).emit(legacyGNSMock, 'SubgraphSentToL2').withArgs(subgraphID)

        const subgraphAfter = await legacyGNSMock.legacySubgraphData(me.address, seqID)
        expect(subgraphAfter.vSignal).eq(0)
        expect(await grt.balanceOf(legacyGNSMock.address)).eq(0)
        expect(subgraphAfter.disabled).eq(true)
        expect(subgraphAfter.withdrawableGRT).eq(0)

        const migrationData = await legacyGNSMock.subgraphL2MigrationData(subgraphID)
        expect(migrationData.lockedAtBlock).eq((await latestBlock()).sub(1))
        expect(migrationData.l1Done).eq(true)

        const expectedCallhookData = l2GNSIface.encodeFunctionData('receiveSubgraphFromL1', [
          subgraphID,
          me.address,
          curatedTokens,
          lockBlockhash,
          subgraphBefore.nSignal,
          subgraphBefore.reserveRatio,
          newSubgraph0.subgraphMetadata,
        ])

        const expectedL2Data = await l1GraphTokenGateway.getOutboundCalldata(
          grt.address,
          legacyGNSMock.address,
          mockL2GNS.address,
          curatedTokens,
          expectedCallhookData,
        )
        await expect(tx)
          .emit(l1GraphTokenGateway, 'TxToL2')
          .withArgs(legacyGNSMock.address, mockL2Gateway.address, toBN(1), expectedL2Data)
      })
      it('rejects calls from someone who is not the subgraph owner', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)
        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = gns
          .connect(other.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).revertedWith('GNS: Must be authorized')
      })
      it('rejects calls for a subgraph that is not locked', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = gns
          .connect(me.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).revertedWith('!LOCKED')
      })
      it('rejects calls for a subgraph that was already sent', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = gns
          .connect(me.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).emit(gns, 'SubgraphSentToL2').withArgs(subgraph0.id)

        const tx2 = gns
          .connect(me.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx2).revertedWith('ALREADY_DONE')
      })
      it('rejects calls after too many blocks have passed', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        await advanceBlocks(256)

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = gns
          .connect(me.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).revertedWith('TOO_LATE')
      })
    })
    describe('deprecateLockedSubgraph', function () {
      it('can be called by anyone, and makes the GRT from the subgraph withdrawable', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const [beforeTokens] = await getTokensAndVSignal(newSubgraph0.subgraphDeploymentID)
        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        await advanceBlocks(256)

        // Now the subgraph can be deprecated (by someone else!)
        const tx = gns.connect(other.signer).deprecateLockedSubgraph(subgraph0.id)
        await expect(tx).emit(gns, 'SubgraphDeprecated').withArgs(subgraph0.id, beforeTokens)
        // After state, same as with deprecateSubgraph
        const afterSubgraph = await gns.subgraphs(subgraph0.id)
        // Check marked as deprecated
        expect(afterSubgraph.disabled).eq(true)
        // Signal for the deployment must be all burned
        expect(afterSubgraph.vSignal.eq(toBN('0')))
        // Cleanup reserve ratio
        expect(afterSubgraph.reserveRatio).eq(0)
        // Should be equal since owner pays curation tax
        expect(afterSubgraph.withdrawableGRT).eq(beforeTokens)
      })
      it('rejects calls for a subgraph that was not locked', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        await advanceBlocks(256)

        const tx = gns.connect(me.signer).deprecateLockedSubgraph(subgraph0.id)
        await expect(tx).revertedWith('!LOCKED')
      })
      it('rejects calls if not enough blocks have passed', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        await advanceBlocks(255) // Not enough!

        const tx = gns.connect(other.signer).deprecateLockedSubgraph(subgraph0.id)
        await expect(tx).revertedWith('TOO_EARLY')
      })
      it('rejects calls for a subgraph that was sent to L2', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        await advanceBlocks(254)

        const maxSubmissionCost = toBN('100')
        const maxGas = toBN('10')
        const gasPriceBid = toBN('20')
        const tx = gns
          .connect(me.signer)
          .sendSubgraphToL2(subgraph0.id, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(maxGas.mul(gasPriceBid)),
          })
        await expect(tx).emit(gns, 'SubgraphSentToL2').withArgs(subgraph0.id)

        await advanceBlock()
        const tx2 = gns.connect(other.signer).deprecateLockedSubgraph(subgraph0.id)
        await expect(tx2).revertedWith('ALREADY_DONE')
      })
      it('rejects calls for a subgraph that was already deprecated', async function () {
        // Publish a named subgraph-0 -> subgraphDeployment0
        const subgraph0 = await publishNewSubgraph(me, newSubgraph0)

        // Curate on the subgraph
        await gns.connect(me.signer).mintSignal(subgraph0.id, toGRT('90000'), 0)

        const [beforeTokens] = await getTokensAndVSignal(newSubgraph0.subgraphDeploymentID)
        await gns.connect(me.signer).lockSubgraphForMigrationToL2(subgraph0.id)

        await advanceBlocks(256)

        const tx = gns.connect(other.signer).deprecateLockedSubgraph(subgraph0.id)
        await expect(tx).emit(gns, 'SubgraphDeprecated').withArgs(subgraph0.id, beforeTokens)
        const tx2 = gns.connect(other.signer).deprecateLockedSubgraph(subgraph0.id)
        await expect(tx2).revertedWith('ALREADY_DONE')
      })
    })
    describe('claimCuratorBalanceToBeneficiaryOnL2', function () {
      it('sends a transaction with a curator balance to the L2GNS using the Arbitrum inbox')
      it('sends a transaction with a curator balance from a legacy subgraph to the L2GNS')
      it('rejects calls for a subgraph that was locked but not sent to L2')
      it('rejects calls for a subgraph that was not locked')
      it('rejects calls for a subgraph that was locked but deprecated')
      it('rejects calls with an incorrect eth value')
      it('rejects calls with zero maxSubmissionCost')
    })
  })
})
