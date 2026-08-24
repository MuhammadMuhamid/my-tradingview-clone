#!/usr/bin/env python3
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from indexed_results import show
show(os.path.dirname(os.path.abspath(__file__)))
