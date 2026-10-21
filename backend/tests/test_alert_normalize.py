"""Normalisation tests for the Tarsier ``eventInfo`` Java-Map payload.

These cover the push format used by 集中监控 (Tarsier): ``eventInfo`` is a
*stringified* Java ``Map.toString()`` whose values contain ASCII commas,
``=``, ``|``, Chinese punctuation and ``null``/empty values.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from app.services.alert_pipeline import (
    CST,
    dedup_key,
    normalize_alert,
    severity_level,
)

SAMPLE_EVENT_INFO = (
    "{ALARMWORKFLOW=1, kpiUnit=null, CITEM=, "
    "SOURCEEVENTID=RW20260914154312023_20260914154312, SOURCEALERTKEY=XCP3532B, "
    "CINAME=5308353857500138, SOURCENAME=应用监控, "
    "SUMMARY=错误信息:TCCM记账失败|告警信息(简要): 告警名称: 批次查证记账告警, "
    "告警联系人: 毕玉朋 , CICATEGORYNAME=应用监控默认丰富, "
    "CICATEGORYID=100000000073502, CREATE_TIME=0, KPITYPE=W01_00, "
    "CIID=1000000000454628, CITYPE=801, LASTOCCURRENCE=2026-09-14T15:43:12, "
    "SOURCESEVERITY=2_2, KPINAME=XCP3532B, SOURCEID=12, SEVERITY=2, "
    "MODIFY_TIME=20260914154313, ID=HW3224009787-2269, "
    "SERIAL=HW3224009787-2269, CIAPPLICATION=, SERVERSERIAL=1, "
    "SERVERNAME=EPServer1, IFNOTIFY=1, ACKNOWLEDGED=0, "
    "SOURCESUMMARY=错误信息:TCCM记账失败|告警信息(简要): 告警名称: 批次查证记账告警, "
    "ALARMTICKET=1, DURATION=null}"
)

SAMPLE_SUMMARY = (
    "错误信息:TCCM记账失败|告警信息(简要): 告警名称: 批次查证记账告警, "
    "告警联系人: 毕玉朋"
)


def test_event_info_java_map_string_full_mapping() -> None:
    normalized = normalize_alert({"eventInfo": SAMPLE_EVENT_INFO})
    assert normalized is not None

    assert normalized["alert_uid"] == "HW3224009787-2269"  # SERIAL
    assert normalized["severity"] == "2"
    assert severity_level(normalized["severity"]) == 2
    # ASCII comma after 告警名称 must stay inside the value.
    assert normalized["content"] == SAMPLE_SUMMARY
    assert normalized["alert_time"] == datetime(
        2026, 9, 14, 15, 43, 12, tzinfo=CST
    )
    assert normalized["source"] == "应用监控"
    assert normalized["ci_name"] == "5308353857500138"
    assert normalized["ci_application"] == "应用监控默认丰富"
    assert normalized["ci_id"] == "1000000000454628"
    assert normalized["ci_type"] == "801"
    assert normalized["metric"] == "XCP3532B"
    # 原始报文保留（含原始 eventInfo 字符串，便于排障）。
    assert normalized["raw"]["_eventInfo"].startswith("{ALARMWORKFLOW=1")
    assert normalized["raw"]["SERIAL"] == "HW3224009787-2269"


def test_event_info_as_dict_legacy_format() -> None:
    normalized = normalize_alert(
        {"eventInfo": {"SERIAL": "D-1", "SEVERITY": 3, "SUMMARY": "旧格式 dict"}}
    )
    assert normalized is not None
    assert normalized["alert_uid"] == "D-1"
    assert normalized["content"] == "旧格式 dict"
    assert severity_level(normalized["severity"]) == 3
    assert normalized["alert_time"].tzinfo is not None


def test_event_info_as_json_object_string() -> None:
    payload = {"eventInfo": json.dumps(
        {"SERIAL": "J-1", "SEVERITY": 4, "SUMMARY": "JSON 字符串"},
        ensure_ascii=False,
    )}
    normalized = normalize_alert(payload)
    assert normalized is not None
    assert normalized["alert_uid"] == "J-1"
    assert normalized["content"] == "JSON 字符串"
    assert severity_level(normalized["severity"]) == 4


def test_values_with_comma_equals_pipe_and_chinese_punctuation() -> None:
    event_info = (
        "{SUMMARY=错误信息:记账时 a=b 校验失败，退货单号：A,B；原因:超时|重试, "
        "附加说明: 见工单 (2026-09) , SEVERITY=2, SERIAL=S-1, CINAME=host-1}"
    )
    normalized = normalize_alert({"eventInfo": event_info})
    assert normalized is not None
    assert normalized["content"] == (
        "错误信息:记账时 a=b 校验失败，退货单号：A,B；原因:超时|重试, "
        "附加说明: 见工单 (2026-09)"
    )
    assert normalized["alert_uid"] == "S-1"
    assert normalized["ci_name"] == "host-1"


def test_null_and_empty_values_fall_back() -> None:
    event_info = (
        "{SUMMARY=, SOURCESUMMARY=回退内容, SERIAL=, ID=, "
        "DUPLICATESERIAL=, SOURCEEVENTID=EV-1, SEVERITY=null, "
        "CINAME=, SERVERNAME=EPServer1, CIAPPLICATION=, "
        "CICATEGORYNAME=应用监控默认丰富, CITEM=, kpiUnit=null}"
    )
    normalized = normalize_alert({"eventInfo": event_info})
    assert normalized is not None
    # alertId ← SERIAL → ID → DUPLICATESERIAL → SOURCEEVENTID
    assert normalized["alert_uid"] == "EV-1"
    assert normalized["content"] == "回退内容"  # SUMMARY 空 → SOURCESUMMARY
    assert normalized["ci_name"] == "EPServer1"  # CINAME 空 → SERVERNAME
    assert normalized["ci_application"] == "应用监控默认丰富"  # CIAPPLICATION 空
    # null 视为空 → 兜底级别（normal → 4）。
    assert severity_level(normalized["severity"]) == 4


def test_unbalanced_braces_do_not_swallow_remaining_fields() -> None:
    event_info = "{SUMMARY=括号(未闭合, SEVERITY=2, SERIAL=U-1, CINAME=h-1}"
    normalized = normalize_alert({"eventInfo": event_info})
    assert normalized is not None
    assert normalized["content"] == "括号(未闭合"
    assert normalized["alert_uid"] == "U-1"
    assert normalized["ci_name"] == "h-1"


def test_single_element_array_is_accepted() -> None:
    normalized = normalize_alert([{"eventInfo": SAMPLE_EVENT_INFO}])
    assert normalized is not None
    assert normalized["alert_uid"] == "HW3224009787-2269"
    # 多条数组由 /webhook 逐条处理；normalize_alert 只认单条。
    assert normalize_alert([{"SERIAL": "a"}, {"SERIAL": "b"}]) is None


def test_unparsable_event_info_is_rejected() -> None:
    # 保持旧语义：eventInfo 存在但不是可解析的映射 → 拒绝（返回 None）。
    assert normalize_alert({"eventInfo": "not-a-map"}) is None
    assert normalize_alert({"eventInfo": ""}) is None


def test_severity_numeric_and_named_levels() -> None:
    for raw, level in ((1, 1), (2, 2), (3, 3), (4, 4), (5, 5)):
        normalized = normalize_alert({"SEVERITY": raw, "SERIAL": f"s{raw}"})
        assert normalized is not None
        assert severity_level(normalized["severity"]) == level
    for raw, level in (("2", 2), ("2_2", 2), ("严重", 1), ("提示", 5)):
        assert severity_level(raw) == level


def test_dedup_key_is_stable_per_serial() -> None:
    first = normalize_alert({"eventInfo": SAMPLE_EVENT_INFO})
    second = normalize_alert({"eventInfo": SAMPLE_EVENT_INFO})
    third = normalize_alert({"eventInfo": SAMPLE_EVENT_INFO.replace(
        "SERIAL=HW3224009787-2269", "SERIAL=HW3224009787-2270")})
    assert first is not None and second is not None and third is not None
    assert dedup_key(first) == dedup_key(second) == "rid:HW3224009787-2269"
    assert dedup_key(first) != dedup_key(third)


def test_alert_time_parsing_iso_and_epoch() -> None:
    iso = normalize_alert({"LASTOCCURRENCE": "2026-09-14T15:43:12", "SERIAL": "t1"})
    assert iso is not None
    assert iso["alert_time"] == datetime(2026, 9, 14, 15, 43, 12, tzinfo=CST)
    assert iso["alert_time"].utcoffset() == timedelta(hours=8)
    epoch = normalize_alert({"LASTOCCURRENCE": "1789458192", "SERIAL": "t2"})
    assert epoch is not None
    assert epoch["alert_time"].year == 2026
