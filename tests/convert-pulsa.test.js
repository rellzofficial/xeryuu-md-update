'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const convert = require('../library/convert-pulsa')

test('amount parser accepts formatted rupiah and rejects empty/unsafe values', () => {
    assert.equal(convert.amountValue('Rp 100.000'), 100000)
    assert.equal(convert.amountValue('50,000'), 50000)
    assert.ok(Number.isNaN(convert.amountValue('nominal')))
    assert.ok(Number.isNaN(convert.amountValue('9007199254740992')))
})

test('operator parser normalizes response envelopes without fabricating unsupported choices', () => {
    const operators = convert.parseOperators({
        success: true,
        data: {
            operators: [
                { operator_id: 1, operator_name: 'Telkomsel', rate: 80, min_amount: 10000, max_amount: 1000000, is_active: true },
                { operator_id: 1, operator_name: 'Telkomsel duplicate', rate: 80, is_active: true },
                { operator_id: 2, operator_name: 'Operator Offline', status: 'maintenance' },
                { operator_id: 3, operator_name: 'Malformed rate', rate: 0, is_active: true }
            ],
            payout_methods: ['DANA', { code: 'GOPAY', label: 'GoPay', active: true }, { code: 'OVO', active: false }]
        }
    })
    assert.equal(operators.length, 3)
    assert.equal(operators[0].id, '1')
    assert.equal(operators[0].rate, 0.8)
    assert.equal(operators[0].minAmount, 10000)
    assert.equal(operators[1].available, false)
    assert.equal(operators[2].rate, null)

    const methods = convert.parsePayoutMethods({ data: { payout_methods: ['DANA', { code: 'GOPAY', label: 'GoPay', active: true }, { code: 'OVO', active: false }] } })
    assert.deepEqual(methods.map(method => method.value), ['DANA', 'GOPAY'])
})

test('provider statuses map into safe internal states', () => {
    assert.equal(convert.normaliseStatus('waiting_transfer'), 'WAITING_TRANSFER')
    assert.equal(convert.normaliseStatus('payment received'), 'PROCESSING')
    assert.equal(convert.normaliseStatus('payout_success'), 'SUCCESS')
    assert.equal(convert.normaliseStatus('rejected'), 'FAILED')
    assert.equal(convert.normaliseStatus('expired'), 'EXPIRED')
    assert.equal(convert.isTerminal('SUCCESS'), true)
    assert.equal(convert.isTerminal('PROCESSING'), false)
    assert.equal(convert.isTerminal('REVIEW_REQUIRED'), false)
})

test('generic API status messages are not treated as transfer instructions', () => {
    const generic = convert.extractInstructions({
        status: 'WAITING_TRANSFER',
        message: 'Order created successfully',
        note: 'Request accepted'
    })
    assert.equal(generic.receiverNumber, '')
    assert.equal(generic.ussd, '')
    assert.equal(generic.instructionText, '')
    assert.equal(convert.hasOfficialInstructions({ instructionText: 'Order created successfully' }), false)
})

test('receipt proof requires a provider transaction and official transfer details unless processing', () => {
    assert.equal(convert.canSubmitProof({
        providerTrxId: 'PJS-123', status: 'WAITING_TRANSFER', instructionText: 'Order created successfully'
    }), false)
    assert.equal(convert.canSubmitProof({
        providerTrxId: 'PJS-123', status: 'WAITING_TRANSFER', receiverNumber: '081234567890'
    }), true)
    assert.equal(convert.canSubmitProof({ providerTrxId: 'PJS-123', status: 'PROCESSING' }), true)
    assert.equal(convert.canSubmitProof({ providerTrxId: '', status: 'PROCESSING' }), false)
})
