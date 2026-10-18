function analyzeVirtex(text, options = {}) {
    const value = String(text || '')

    const maxLength = Number(options.maxLength || 50000)
    const minScore = Number(options.minScore || 6)

    if (!value) {
        return {
            detected: false,
            score: 0,
            reasons: []
        }
    }

    let score = 0
    const reasons = []

    // ==========================================
    // 1. PANJANG PESAN
    // ==========================================
    if (value.length >= maxLength) {
        score += 5

        reasons.push(
            `pesan sangat panjang (${value.length.toLocaleString('id-ID')} karakter)`
        )
    }

    // ==========================================
    // 2. INVISIBLE / FORMAT CHARACTERS
    // ==========================================
    const invisible = (
        value.match(
            /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu
        ) || []
    ).length

    if (invisible >= 3000) {
        score += 5
        reasons.push(
            `invisible character berlebihan (${invisible.toLocaleString('id-ID')})`
        )
    } else if (invisible >= 1000) {
        score += 3
        reasons.push(
            `banyak invisible character (${invisible.toLocaleString('id-ID')})`
        )
    }

    // ==========================================
    // 3. COMBINING MARK
    // ==========================================
    const combining = (
        value.match(
            /[\u0300-\u036f\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/gu
        ) || []
    ).length

    if (combining >= 10000) {
        score += 5
        reasons.push(
            `combining character berlebihan (${combining.toLocaleString('id-ID')})`
        )
    } else if (combining >= 5000) {
        score += 3
        reasons.push(
            `banyak combining character (${combining.toLocaleString('id-ID')})`
        )
    }

    // ==========================================
    // 4. NEWLINE BERLEBIHAN
    // ==========================================
    const newlines = (
        value.match(/\n/g) || []
    ).length

    if (newlines >= 10000) {
        score += 4
        reasons.push(
            `newline berlebihan (${newlines.toLocaleString('id-ID')})`
        )
    }

    // ==========================================
    // 5. KARAKTER DOMINAN
    // ==========================================
    const sample = value.slice(0, 100000)

    if (sample.length >= 10000) {
        const counter = new Map()

        for (const char of sample) {
            counter.set(
                char,
                (counter.get(char) || 0) + 1
            )
        }

        let highest = 0

        for (const count of counter.values()) {
            if (count > highest) {
                highest = count
            }
        }

        const ratio = highest / sample.length

        if (ratio >= 0.95) {
            score += 4

            reasons.push(
                `karakter yang sama mendominasi ${(ratio * 100).toFixed(1)}% pesan`
            )
        } else if (ratio >= 0.85) {
            score += 2

            reasons.push(
                `karakter berulang ${(ratio * 100).toFixed(1)}%`
            )
        }
    }

    return {
        detected: score >= minScore,
        score,
        reasons,
        length: value.length,
        invisible,
        combining,
        newlines
    }
}

module.exports = {
    analyzeVirtex
}