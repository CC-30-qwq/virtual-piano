@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "d:\My_Project\Cocos_Project\virtual-piano"
cl /nologo /std:c++17 /utf-8 /EHsc /O2 /W4 /c /I"d:\My_Project\Cocos_Project\virtual-piano\native\engine\common\Classes\piano" /I"d:\My_Project\Cocos_Project\virtual-piano\native\engine\common\third_party" "d:\My_Project\Cocos_Project\virtual-piano\native\engine\common\Classes\piano\SampleBank.cpp" /Fo:"d:\My_Project\Cocos_Project\virtual-piano\tests\cpp\.syntax\SampleBank.cpp.obj"
