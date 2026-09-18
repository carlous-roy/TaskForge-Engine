package com.taskforge.worker.report;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class CsvWriterTest {

    @Test
    void quotesFieldsWithCommasQuotesAndLineBreaks() {
        String csv = new String(new CsvWriter()
                .row("plain", "with, comma", "with \"quote\"", "multi\nline", null, 3, 2.5)
                .toBytes(), StandardCharsets.UTF_8);
        assertThat(csv).isEqualTo("plain,\"with, comma\",\"with \"\"quote\"\"\",\"multi\nline\",,3,2.50\r\n");
    }

    @Test
    void notesAreSeparatedByABlankLine() {
        String csv = new String(new CsvWriter().row("a").note("# Summary: 1").toBytes(), StandardCharsets.UTF_8);
        assertThat(csv).isEqualTo("a\r\n\r\n# Summary: 1\r\n");
    }

    @Test
    void moneyAlwaysHasTwoDecimalsAndAPoint() {
        assertThat(CsvWriter.money(1234.5)).isEqualTo("1234.50");
        assertThat(CsvWriter.money(0)).isEqualTo("0.00");
    }
}
